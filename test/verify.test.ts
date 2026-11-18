import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { commandUsage, main, parseArgs } from '../src/cli.js';
import { formatVerifyReport, runVerifyCommand } from '../src/commands/verify.js';
import { corpusHash } from '../src/core/changes.js';
import { ServiceError } from '../src/core/errors.js';
import { loadConfig } from '../src/config.js';
import { EXIT } from '../src/exit-codes.js';
import { createTestLogger, FIXTURE_SECTIONS, makeSection, openTempStore } from './helpers.js';

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function makeIo(env: NodeJS.ProcessEnv = {}): {
  out: string[];
  err: string[];
  io: { out(c: string): void; err(c: string): void; env: NodeJS.ProcessEnv };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (chunk) => out.push(chunk),
      err: (chunk) => err.push(chunk),
      env,
    },
  };
}

/** Seed a temp store AND record the receipt its seeded rows imply. */
function openReceiptedStore() {
  const temp = openTempStore();
  temp.store.setMeta('corpus_hash', corpusHash(temp.store.snapshotTextHashes(38)));
  return temp;
}

/** Run `fn` and return the ServiceError it threw (the test asserts on it). */
function captureServiceError(fn: () => unknown): ServiceError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
  throw new Error('expected a ServiceError, none was thrown');
}

describe('verify argument parsing', () => {
  it('parses verify with and without a snapshot path', () => {
    expect(parseArgs(['verify'])).toEqual({ command: 'verify' });
    expect(parseArgs(['verify', './backup.sqlite'])).toEqual({
      command: 'verify',
      snapshot: './backup.sqlite',
    });
  });

  it('rejects extra arguments and dash-prefixed paths', () => {
    expect(() => parseArgs(['verify', 'a', 'b'])).toThrow(/at most one snapshot path/);
    expect(() => parseArgs(['verify', '--json'])).toThrow(/at most one snapshot path/);
  });

  it('is a known command with its own usage text', () => {
    expect(parseArgs(['verify', '--help'])).toEqual({ command: 'help', topic: 'verify' });
    expect(commandUsage('verify')).toContain('cfr-free verify [snapshot]');
  });
});

describe('runVerifyCommand', () => {
  it('verifies a usable index: schema, counts, issue date and a matching receipt', () => {
    const temp = openReceiptedStore();
    try {
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const report = runVerifyCommand(config, createTestLogger());
      expect(report).toMatchObject({
        path: temp.indexPath,
        sections: 3,
        appendices: 1,
        issueDate: '2026-10-09',
        receipt: 'match',
      });
      expect(report.recordedCorpusHash).toBe(report.recomputedCorpusHash);
      const output = formatVerifyReport(report);
      expect(output).toContain('schema: ok');
      expect(output).toContain('3 sections + 1 appendices');
      expect(output).toContain('issue date: 2026-10-09');
      expect(output).toContain('corpus receipt: match');
    } finally {
      temp.cleanup();
    }
  });

  it('verifies a stored snapshot passed positionally, resolving the path', () => {
    const temp = openReceiptedStore();
    const snapshot = path.join(temp.dir, 'backup.sqlite');
    try {
      temp.store.backupTo(snapshot);
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const report = runVerifyCommand(config, createTestLogger(), snapshot);
      expect(report.path).toBe(snapshot);
      expect(report.receipt).toBe('match');
      expect(report.sections).toBe(3);
      expect(report.appendices).toBe(1);
    } finally {
      temp.cleanup();
    }
  });

  it('reports an absent receipt: usable, but row provenance cannot be concluded', () => {
    // The fixture seed records no corpus_hash (the pre-receipt shape).
    const temp = openTempStore();
    try {
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const report = runVerifyCommand(config, createTestLogger());
      expect(report.receipt).toBe('absent');
      expect(report.recordedCorpusHash).toBeNull();
      const output = formatVerifyReport(report);
      expect(output).toContain('corpus receipt: absent');
      expect(output).toContain('cannot be concluded either way');
      // What CAN be concluded is stated too: the file opened and counted.
      expect(output).toContain('schema: ok');
      expect(output).toContain('3 sections + 1 appendices');
    } finally {
      temp.cleanup();
    }
  });

  it('reports an index that records neither an issue date nor a receipt', () => {
    const temp = openTempStore({ seed: false });
    try {
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const report = runVerifyCommand(config, createTestLogger());
      expect(report.issueDate).toBeNull();
      expect(report.sections).toBe(0);
      expect(report.appendices).toBe(0);
      expect(report.receipt).toBe('absent');
      const output = formatVerifyReport(report);
      expect(output).toContain('issue date: none recorded');
      expect(output).toContain('0 sections + 0 appendices');
    } finally {
      temp.cleanup();
    }
  });

  it('falls back to the legacy issue_date key when the per-title key is absent', () => {
    const temp = openTempStore();
    try {
      const db = new DatabaseSync(temp.indexPath);
      db.prepare("DELETE FROM meta WHERE key = 'title.38.issue_date'").run();
      db.close();
      temp.store.setMeta('issue_date', '2026-01-02');
      temp.store.setMeta('corpus_hash', corpusHash(temp.store.snapshotTextHashes(38)));
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const report = runVerifyCommand(config, createTestLogger());
      expect(report.issueDate).toBe('2026-01-02');
      expect(report.receipt).toBe('match');
    } finally {
      temp.cleanup();
    }
  });

  it('detects a tampered row: the recorded receipt mismatches the recomputed rows', () => {
    const temp = openReceiptedStore();
    try {
      // The receipt was recorded for the INTACT rows; then one row is
      // tampered with the way a corrupted copy would differ — beneath the
      // meta layer the receipt lives in.
      const db = new DatabaseSync(temp.indexPath);
      db.prepare("UPDATE sections SET text = text || ' [tampered]' WHERE citation = '4.125'").run();
      db.close();
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const report = runVerifyCommand(config, createTestLogger());
      expect(report.receipt).toBe('mismatch');
      expect(report.recordedCorpusHash).not.toBe(report.recomputedCorpusHash);
      const output = formatVerifyReport(report);
      expect(output).toContain('corpus receipt: MISMATCH');
      expect(output).toContain(`recorded:   ${report.recordedCorpusHash}`);
      expect(output).toContain(`recomputed: ${report.recomputedCorpusHash}`);
    } finally {
      temp.cleanup();
    }
  });

  it('refuses a missing path as invalid input', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfr-verify-'));
    try {
      const missing = path.join(dir, 'missing.sqlite');
      const config = loadConfig({ CFR_INDEX_PATH: missing });
      const error = captureServiceError(() => runVerifyCommand(config, createTestLogger()));
      expect(error.code).toBe('invalid_input');
      expect(error.message).toMatch(/no index or snapshot here/);
      const positional = captureServiceError(() =>
        runVerifyCommand(config, createTestLogger(), missing),
      );
      expect(positional.code).toBe('invalid_input');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file that is not a cfr-free index', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfr-verify-'));
    try {
      const foreign = path.join(dir, 'foreign.sqlite');
      // A SQLite file holding another program's table.
      const db = new DatabaseSync(foreign);
      db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
      db.close();
      const plain = path.join(dir, 'notes.txt');
      writeFileSync(plain, 'not a database at all');
      const config = loadConfig({ CFR_INDEX_PATH: foreign });
      const error = captureServiceError(() => runVerifyCommand(config, createTestLogger()));
      expect(error.code).toBe('invalid_input');
      expect(error.message).toMatch(/not a cfr-free index/);
      const positional = captureServiceError(() =>
        runVerifyCommand(config, createTestLogger(), plain),
      );
      expect(positional.code).toBe('invalid_input');
      expect(positional.message).toMatch(/cannot open as a cfr-free index/);
      // The refusal names the path once, not twice.
      expect(positional.message).not.toMatch(/cannot open index at/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verify CLI dispatch and exit codes', () => {
  it('exits 0 and prints the report for a verified index', async () => {
    const temp = openReceiptedStore();
    try {
      const { out, io } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
      const code = await main(['verify'], io);
      expect(code).toBe(EXIT.OK);
      expect(out.join('')).toContain('corpus receipt: match');
    } finally {
      temp.cleanup();
    }
  });

  it('exits 0 and reports an absent receipt clearly', async () => {
    const temp = openTempStore();
    try {
      const { out, io } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
      const code = await main(['verify'], io);
      expect(code).toBe(EXIT.OK);
      expect(out.join('')).toContain('corpus receipt: absent');
    } finally {
      temp.cleanup();
    }
  });

  it('exits 1 when the recorded receipt mismatches the current rows', async () => {
    const temp = openReceiptedStore();
    try {
      const db = new DatabaseSync(temp.indexPath);
      db.prepare("UPDATE sections SET heading = 'Retitled.' WHERE citation = '4.130'").run();
      db.close();
      const { out, io } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
      const code = await main(['verify'], io);
      expect(code).toBe(EXIT.ERROR);
      // The report is still the answer: it is printed, not swallowed.
      expect(out.join('')).toContain('corpus receipt: MISMATCH');
    } finally {
      temp.cleanup();
    }
  });

  it('exits 2 for a missing default index, a missing snapshot and a non-index file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfr-verify-'));
    try {
      const missing = path.join(dir, 'missing.sqlite');
      const { io: ioMissing } = makeIo({ CFR_INDEX_PATH: missing });
      expect(await main(['verify'], ioMissing)).toBe(EXIT.USAGE);

      const temp = openReceiptedStore();
      try {
        const { err: errSnap, io: ioSnap } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
        expect(await main(['verify', path.join(dir, 'no-such.sqlite')], ioSnap)).toBe(EXIT.USAGE);
        expect(errSnap.join('')).toMatch(/no index or snapshot/);

        const foreign = path.join(dir, 'foreign.sqlite');
        const db = new DatabaseSync(foreign);
        db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
        db.close();
        const { io: ioForeign } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
        expect(await main(['verify', foreign], ioForeign)).toBe(EXIT.USAGE);
      } finally {
        temp.cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies a snapshot positionally and leaves the file byte-for-byte unchanged', async () => {
    const temp = openReceiptedStore();
    const snapshot = path.join(temp.dir, 'backup.sqlite');
    try {
      temp.store.backupTo(snapshot);
      const before = sha256(snapshot);
      const { out, io } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
      const code = await main(['verify', snapshot], io);
      expect(code).toBe(EXIT.OK);
      expect(out.join('')).toContain(`verified ${snapshot}`);
      expect(out.join('')).toContain('corpus receipt: match');
      expect(sha256(snapshot)).toBe(before);
    } finally {
      temp.cleanup();
    }
  });

  it("verifies a snapshot against its OWN receipt, not the live index's", async () => {
    // The positional path is the subject: an older stored snapshot must
    // verify against the receipt recorded with ITS rows, even when the live
    // index holds different ones.
    const temp = openReceiptedStore();
    const snapshot = path.join(temp.dir, 'older.sqlite');
    try {
      const older = FIXTURE_SECTIONS.map((section) =>
        makeSection({ ...section, citation: section.citation }),
      );
      const olderStore = openTempStore({ sections: older, issueDate: '2026-01-01' });
      try {
        // The snapshot records its own receipt for its own rows.
        olderStore.store.setMeta(
          'corpus_hash',
          corpusHash(olderStore.store.snapshotTextHashes(38)),
        );
        olderStore.store.backupTo(snapshot);
      } finally {
        olderStore.cleanup();
      }
      const { out, io } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
      const code = await main(['verify', snapshot], io);
      expect(code).toBe(EXIT.OK);
      expect(out.join('')).toContain('corpus receipt: match');
      expect(out.join('')).toContain('issue date: 2026-01-01');
    } finally {
      temp.cleanup();
    }
  });
});
