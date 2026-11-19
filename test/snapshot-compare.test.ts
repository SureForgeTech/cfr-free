import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ServiceError } from '../src/core/errors.js';
import { compareSnapshots } from '../src/core/snapshot-compare.js';
import { Store } from '../src/core/store.js';
import type { RawSection } from '../src/core/xml.js';
import { createTestLogger, makeSection } from './helpers.js';

const FROM_DATE = '2026-01-01';
const TO_DATE = '2026-02-01';

function writeSnapshot(filePath: string, sections: readonly RawSection[], issueDate: string): void {
  const store = Store.open(filePath);
  try {
    store.replaceAll(sections, issueDate, {});
  } finally {
    store.close();
  }
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function snapshotDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cfr-free-snapshots-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function standardFixture(dir: string): { from: string; to: string } {
  const from = path.join(dir, 'from.sqlite');
  const to = path.join(dir, 'to.sqlite');
  writeSnapshot(
    from,
    [
      makeSection({
        citation: '4.1',
        heading: 'Evaluation criteria.',
        text: 'Common line.\nOld criteria.',
      }),
      makeSection({ citation: '4.2', heading: 'Removed section.', text: 'Removed body.' }),
      makeSection({ citation: '4.3', heading: 'Unchanged section.', text: 'Same body.' }),
      makeSection({ citation: '4.5', heading: 'Old title.', text: 'Same body.' }),
    ],
    FROM_DATE,
  );
  writeSnapshot(
    to,
    [
      makeSection({
        citation: '4.1',
        heading: 'Evaluation criteria.',
        text: 'Common line.\nNew criteria.',
      }),
      makeSection({ citation: '4.3', heading: 'Unchanged section.', text: 'Same body.' }),
      makeSection({ citation: '4.4', heading: 'Added section.', text: 'Added body.' }),
      makeSection({ citation: '4.5', heading: 'New title.', text: 'Same body.' }),
      makeSection({
        citation: 'Appendix A to Part 4',
        kind: 'appendix',
        subpart: null,
        heading: 'Rating table.',
        text: '[image content not included: /graphics/table.svg]',
      }),
    ],
    TO_DATE,
  );
  return { from, to };
}

describe('compareSnapshots', () => {
  it('reports added, removed and changed provisions with dates, hierarchy, sources and text hunks', () => {
    const fixture = snapshotDir();
    try {
      const paths = standardFixture(fixture.dir);
      const result = compareSnapshots({ logger: createTestLogger() }, paths.from, paths.to);

      expect(result.from).toEqual({ path: paths.from, issueDate: FROM_DATE });
      expect(result.to).toEqual({ path: paths.to, issueDate: TO_DATE });
      expect(result.part).toBeNull();
      expect(result.truncated).toBe(false);
      expect(result.added.map((change) => change.citation)).toEqual([
        '4.4',
        'Appendix A to Part 4',
      ]);
      expect(result.removed.map((change) => change.citation)).toEqual(['4.2']);
      expect(result.changed.map((change) => change.citation)).toEqual(['4.1', '4.5']);

      const changed = result.changed.find((change) => change.citation === '4.1');
      expect(changed).toMatchObject({
        kind: 'section',
        heading: 'Evaluation criteria.',
        headingChanged: false,
        previousHeading: null,
        chapter: 'I',
        part: '4',
        subpart: 'B',
        path: '/title:38/chapter:I/part:4/subpart:B',
        fromIssueDate: FROM_DATE,
        toIssueDate: TO_DATE,
        fromSourceUrl: `https://www.ecfr.gov/on/${FROM_DATE}/title-38/section-4.1`,
        toSourceUrl: `https://www.ecfr.gov/on/${TO_DATE}/title-38/section-4.1`,
        imageContent: false,
        summary: {
          truncated: false,
          hunks: [
            { fromLine: 2, toLine: null, type: 'del', text: 'Old criteria.' },
            { fromLine: null, toLine: 2, type: 'add', text: 'New criteria.' },
          ],
        },
      });

      const added = result.added[0];
      expect(added).toMatchObject({
        fromSourceUrl: null,
        toSourceUrl: `https://www.ecfr.gov/on/${TO_DATE}/title-38/section-4.4`,
        summary: {
          truncated: false,
          hunks: [{ fromLine: null, toLine: 1, type: 'add', text: 'Added body.' }],
        },
      });
      const removed = result.removed[0];
      expect(removed).toMatchObject({
        fromSourceUrl: `https://www.ecfr.gov/on/${FROM_DATE}/title-38/section-4.2`,
        toSourceUrl: null,
        summary: {
          truncated: false,
          hunks: [{ fromLine: 1, toLine: null, type: 'del', text: 'Removed body.' }],
        },
      });

      const retitled = result.changed.find((change) => change.citation === '4.5');
      expect(retitled).toMatchObject({
        headingChanged: true,
        previousHeading: 'Old title.',
        summary: { truncated: false, hunks: [] },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('carries the image-content fidelity flag and dated appendix source URLs', () => {
    const fixture = snapshotDir();
    try {
      const from = path.join(fixture.dir, 'from.sqlite');
      const to = path.join(fixture.dir, 'to.sqlite');
      writeSnapshot(
        from,
        [makeSection({ citation: 'Appendix A to Part 4', kind: 'appendix', subpart: null })],
        FROM_DATE,
      );
      writeSnapshot(
        to,
        [
          makeSection({
            citation: 'Appendix A to Part 4',
            kind: 'appendix',
            subpart: null,
            heading: 'Rating table.',
            text: '[image content not included: /graphics/table.svg]',
          }),
        ],
        TO_DATE,
      );

      const result = compareSnapshots({ logger: createTestLogger() }, from, to);
      expect(result.changed[0]).toMatchObject({
        kind: 'appendix',
        imageContent: true,
        fromSourceUrl: `https://www.ecfr.gov/on/${FROM_DATE}/title-38/appendix-Appendix%20A%20to%20Part%204`,
        toSourceUrl: `https://www.ecfr.gov/on/${TO_DATE}/title-38/appendix-Appendix%20A%20to%20Part%204`,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('scopes the comparison to one part', () => {
    const fixture = snapshotDir();
    try {
      const from = path.join(fixture.dir, 'from.sqlite');
      const to = path.join(fixture.dir, 'to.sqlite');
      const sections = (part: string, body: string) => [
        makeSection({
          citation: `${part}.1`,
          part,
          subpart: null,
          path: `/title:38/chapter:I/part:${part}`,
          text: body,
        }),
      ];
      writeSnapshot(
        from,
        [...sections('4', 'Old part 4.'), ...sections('17', 'Old part 17.')],
        FROM_DATE,
      );
      writeSnapshot(
        to,
        [...sections('4', 'New part 4.'), ...sections('17', 'New part 17.')],
        TO_DATE,
      );

      const result = compareSnapshots({ logger: createTestLogger() }, from, to, { part: '4' });
      expect(result.part).toBe('4');
      expect(result.changed.map((change) => change.citation)).toEqual(['4.1']);
    } finally {
      fixture.cleanup();
    }
  });

  it('caps every category at the change-list bound and reports truncation', () => {
    const fixture = snapshotDir();
    try {
      const count = 101;
      const changedFrom = Array.from({ length: count }, (_, i) =>
        makeSection({ citation: `4.c${String(i)}`, text: `Old changed ${i}.` }),
      );
      const changedTo = changedFrom.map((section, i) => ({
        ...section,
        text: `New changed ${i}.`,
      }));
      writeSnapshot(
        fromPath(fixture.dir),
        [
          ...changedFrom,
          ...Array.from({ length: count }, (_, i) =>
            makeSection({ citation: `4.r${String(i)}`, text: `Removed ${i}.` }),
          ),
        ],
        FROM_DATE,
      );
      const to = path.join(fixture.dir, 'to.sqlite');
      writeSnapshot(
        to,
        [
          ...changedTo,
          ...Array.from({ length: count }, (_, i) =>
            makeSection({ citation: `4.a${String(i)}`, text: `Added ${i}.` }),
          ),
        ],
        TO_DATE,
      );

      const result = compareSnapshots({ logger: createTestLogger() }, fromPath(fixture.dir), to);
      expect(result.changed).toHaveLength(100);
      expect(result.removed).toHaveLength(100);
      expect(result.added).toHaveLength(100);
      expect(result.truncated).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('bounds individual hunk text so one long provision line cannot exhaust the wire', () => {
    const fixture = snapshotDir();
    try {
      const from = path.join(fixture.dir, 'from.sqlite');
      const to = path.join(fixture.dir, 'to.sqlite');
      writeSnapshot(
        from,
        [makeSection({ citation: '4.1', text: `old ${'x'.repeat(3_000)}` })],
        FROM_DATE,
      );
      writeSnapshot(
        to,
        [makeSection({ citation: '4.1', text: `new ${'y'.repeat(3_000)}` })],
        TO_DATE,
      );

      const summary = compareSnapshots({ logger: createTestLogger() }, from, to).changed[0]
        ?.summary;
      expect(summary?.truncated).toBe(true);
      for (const hunk of summary?.hunks ?? []) {
        expect(hunk.text.length).toBeLessThanOrEqual(1_001);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('marks long differing-line summaries and uses coarse excerpts above the line cap', () => {
    const fixture = snapshotDir();
    try {
      const from = path.join(fixture.dir, 'from.sqlite');
      const to = path.join(fixture.dir, 'to.sqlite');
      writeSnapshot(
        from,
        [
          makeSection({
            citation: '4.1',
            text: Array.from({ length: 12 }, (_, i) => `old ${i}`).join('\n'),
          }),
        ],
        FROM_DATE,
      );
      writeSnapshot(
        to,
        [
          makeSection({
            citation: '4.1',
            text: Array.from({ length: 12 }, (_, i) => `new ${i}`).join('\n'),
          }),
        ],
        TO_DATE,
      );
      const lineSummary = compareSnapshots({ logger: createTestLogger() }, from, to).changed[0]
        ?.summary;
      expect(lineSummary?.hunks).toHaveLength(10);
      expect(lineSummary?.truncated).toBe(true);

      const manyFrom = Array.from({ length: 2001 }, (_, i) => `old ${i}`).join('\n');
      const manyTo = Array.from({ length: 2001 }, (_, i) => `new ${i}`).join('\n');
      writeSnapshot(from, [makeSection({ citation: '4.1', text: manyFrom })], FROM_DATE);
      writeSnapshot(to, [makeSection({ citation: '4.1', text: manyTo })], TO_DATE);
      const coarse = compareSnapshots({ logger: createTestLogger() }, from, to).changed[0]?.summary;
      expect(coarse?.hunks).toHaveLength(2);
      expect(coarse?.hunks.map((hunk) => hunk.type)).toEqual(['del', 'add']);
      expect(coarse?.truncated).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('returns empty categories when the snapshots have the same recorded revision', () => {
    const fixture = snapshotDir();
    try {
      const from = path.join(fixture.dir, 'from.sqlite');
      const to = path.join(fixture.dir, 'to.sqlite');
      const sections = [makeSection({ citation: '4.1' })];
      writeSnapshot(from, sections, FROM_DATE);
      writeSnapshot(to, sections, FROM_DATE);
      const result = compareSnapshots({ logger: createTestLogger() }, from, to);
      expect(result).toMatchObject({ added: [], removed: [], changed: [], truncated: false });
    } finally {
      fixture.cleanup();
    }
  });

  it('opens snapshots read-only and leaves the files byte-for-byte unchanged', () => {
    const fixture = snapshotDir();
    try {
      const paths = standardFixture(fixture.dir);
      const before = { from: sha256(paths.from), to: sha256(paths.to) };
      compareSnapshots({ logger: createTestLogger() }, paths.from, paths.to);
      expect(sha256(paths.from)).toBe(before.from);
      expect(sha256(paths.to)).toBe(before.to);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects the same path, missing snapshots and non-index files as client-safe input errors', () => {
    const fixture = snapshotDir();
    try {
      const paths = standardFixture(fixture.dir);
      expect(() =>
        compareSnapshots({ logger: createTestLogger() }, paths.from, paths.from),
      ).toThrow(/same file/);
      const missing = path.join(fixture.dir, 'missing.sqlite');
      expect(() => compareSnapshots({ logger: createTestLogger() }, missing, paths.to)).toThrow(
        ServiceError,
      );
      expect(() => compareSnapshots({ logger: createTestLogger() }, missing, paths.to)).toThrow(
        /the from snapshot does not exist.*cfr-free export/,
      );
      const foreign = path.join(fixture.dir, 'foreign.sqlite');
      writeFileSync(foreign, 'not a database');
      expect(() => compareSnapshots({ logger: createTestLogger() }, foreign, paths.to)).toThrow(
        /the from snapshot could not be opened/,
      );
      expect(() => compareSnapshots({ logger: createTestLogger() }, paths.to, paths.from)).toThrow(
        /after the to snapshot/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses a snapshot that is not a regular file, before any database open', () => {
    const fixture = snapshotDir();
    try {
      const paths = standardFixture(fixture.dir);
      const directory = path.join(fixture.dir, 'directory.sqlite');
      mkdirSync(directory);
      expect(() => compareSnapshots({ logger: createTestLogger() }, directory, paths.to)).toThrow(
        /the from snapshot is not a regular file/,
      );

      // A FIFO is the case that matters: opening one with SQLite BLOCKS the
      // synchronous open forever, so a model-supplied path would freeze the
      // whole stdio server. The refusal has to happen BEFORE the open. The
      // writer below keeps the pipe from blocking if the guard is ever
      // removed, so a regression fails this test instead of hanging it.
      const fifo = path.join(fixture.dir, 'fifo.sqlite');
      const made = spawnSync('mkfifo', [fifo]);
      if (made.status === 0) {
        const writer = spawn('sh', ['-c', `head -c 100 /dev/zero > "${fifo}"`], {
          stdio: 'ignore',
        });
        try {
          expect(() => compareSnapshots({ logger: createTestLogger() }, fifo, paths.to)).toThrow(
            /the from snapshot is not a regular file/,
          );
        } finally {
          writer.kill();
        }
      }

      // A snapshot inside a directory nobody may read cannot be inspected at
      // all — that is neither "missing" nor "not a regular file", and the
      // message says so. (Root reads everything and Windows has no POSIX
      // permissions, so the case is skipped there.)
      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        const locked = path.join(fixture.dir, 'locked');
        mkdirSync(locked);
        const hidden = path.join(locked, 'hidden.sqlite');
        writeFileSync(hidden, 'not a database');
        chmodSync(locked, 0o000);
        try {
          expect(() => compareSnapshots({ logger: createTestLogger() }, hidden, paths.to)).toThrow(
            /the from snapshot could not be read/,
          );
        } finally {
          chmodSync(locked, 0o700);
        }
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps the server paths and raw SQLite text out of client-facing errors', () => {
    const fixture = snapshotDir();
    try {
      const paths = standardFixture(fixture.dir);
      const foreign = path.join(fixture.dir, 'foreign.sqlite');
      writeFileSync(foreign, 'not a database');
      const missing = path.join(fixture.dir, 'missing.sqlite');

      for (const bad of [foreign, missing]) {
        let message = '';
        try {
          compareSnapshots({ logger: createTestLogger() }, bad, paths.to);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        // The client is told WHICH side failed and what to do; it is not told
        // where the server's files live, and it is not handed raw SQLite text.
        expect(message).not.toContain(fixture.dir);
        expect(message).not.toContain('SQLITE');
        expect(message).not.toMatch(/not a database/);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('reports the paths the caller named, not the resolved ones', () => {
    const fixture = snapshotDir();
    try {
      const paths = standardFixture(fixture.dir);
      // A path that resolves elsewhere than it is written: the response
      // repeats what the caller asked for and does not disclose the server's
      // resolved directory layout.
      const from = `${paths.from}/../from.sqlite`;
      const comparison = compareSnapshots({ logger: createTestLogger() }, from, paths.to);
      expect(comparison.from.path).toBe(from);
      expect(comparison.to.path).toBe(paths.to);
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses a snapshot whose recorded issue date is later than today', () => {
    // The spec says the comparison of two stored snapshots rejects a
    // recorded issue date later than today as well, so a snapshot with a
    // clock-skewed date is refused rather than compared.
    const fixture = snapshotDir();
    try {
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const file = path.join(fixture.dir, 'future-date.sqlite');
      const other = path.join(fixture.dir, 'other.sqlite');
      writeSnapshot(file, [makeSection({ citation: '4.1' })], future);
      writeSnapshot(other, [makeSection({ citation: '4.2' })], '2026-01-01');

      expect(() => compareSnapshots({ logger: createTestLogger() }, file, other)).toThrow(
        /later than today/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects snapshots with no issue date or an invalid recorded issue date', () => {
    const fixture = snapshotDir();
    try {
      const valid = path.join(fixture.dir, 'valid.sqlite');
      const missingDate = path.join(fixture.dir, 'missing-date.sqlite');
      const invalidDate = path.join(fixture.dir, 'invalid-date.sqlite');
      const legacyDate = path.join(fixture.dir, 'legacy-date.sqlite');
      const oldSchema = path.join(fixture.dir, 'old-schema.sqlite');
      writeSnapshot(valid, [makeSection({ citation: '4.1' })], TO_DATE);
      writeSnapshot(missingDate, [makeSection({ citation: '4.1' })], FROM_DATE);
      writeSnapshot(invalidDate, [makeSection({ citation: '4.1' })], FROM_DATE);
      writeSnapshot(legacyDate, [makeSection({ citation: '4.1' })], FROM_DATE);

      for (const file of [missingDate, invalidDate]) {
        const raw = new DatabaseSync(file);
        raw.exec(
          file === missingDate
            ? "DELETE FROM meta WHERE key IN ('title.38.issue_date', 'issue_date')"
            : "UPDATE meta SET value = 'not-a-date' WHERE key = 'title.38.issue_date'",
        );
        raw.close();
      }
      const legacyRaw = new DatabaseSync(legacyDate);
      legacyRaw.exec("DELETE FROM meta WHERE key = 'title.38.issue_date'");
      legacyRaw.exec("INSERT OR REPLACE INTO meta VALUES ('issue_date', '2026-01-01')");
      legacyRaw.close();
      const oldRaw = new DatabaseSync(oldSchema);
      oldRaw.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO meta VALUES ('issue_date', '${FROM_DATE}');
        PRAGMA user_version = 1`);
      oldRaw.close();

      expect(
        compareSnapshots({ logger: createTestLogger() }, legacyDate, valid).from.issueDate,
      ).toBe(FROM_DATE);
      expect(() => compareSnapshots({ logger: createTestLogger() }, missingDate, valid)).toThrow(
        /records no issue date/,
      );
      expect(() => compareSnapshots({ logger: createTestLogger() }, invalidDate, valid)).toThrow(
        /recorded issue date.*YYYY-MM-DD/,
      );
      // The client gets guidance, not the diagnostic: the detail (the schema
      // version the file holds) stays in the server log.
      const oldSchemaLogger = createTestLogger();
      expect(() => compareSnapshots({ logger: oldSchemaLogger }, oldSchema, valid)).toThrow(
        /the from snapshot could not be opened/,
      );
      expect(
        oldSchemaLogger.records.some(
          (record) =>
            record.level === 'error' && /schema version 1/.test(String(record.fields?.message)),
        ),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});

function fromPath(dir: string): string {
  return path.join(dir, 'from.sqlite');
}
