import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { CORPUS_RECEIPT_LIMIT, corpusHash } from '../core/changes.js';
import { ServiceError } from '../core/errors.js';
import { DEFAULT_TITLE, Store } from '../core/store.js';
import type { Logger } from '../logger.js';

/**
 * `cfr-free verify [snapshot]` — prove whether the local index, or a stored
 * snapshot of it, is internally usable and whether the corpus receipt it
 * records still describes its current Title 38 rows.
 *
 * The file is opened through the strict read-only evidence path (no
 * creation, no journal-mode rewrite, no schema adoption, no upgrade): a
 * verification never repairs or alters the file it reads, so it can be run
 * on evidence — the same read-only contract as the offline snapshot
 * comparison (`src/core/snapshot-compare.ts`).
 *
 * Exit policy (enforced by the CLI dispatch, `src/cli.ts`): a readable index
 * reports and exits 0, INCLUDING when it records no receipt — the absent
 * case is reported plainly, not hidden. An unreadable, missing or non-index
 * input is an `invalid_input` failure, which the CLI's existing mapping
 * turns into exit 2 (usage). A readable file whose recorded receipt
 * MISMATCHES the receipt recomputed from its current rows answers "is this
 * the copy the receipt describes?" with "no": that is the command's finding,
 * so the report is still printed and the exit code is 1 (`EXIT.ERROR` — no
 * new exit code).
 */

/** The receipt verdict: the recorded hash is gone, agrees, or disagrees. */
export type CorpusReceiptStatus = 'match' | 'mismatch' | 'absent';

export interface VerifyReport {
  /** The file verified (the configured index path or the resolved snapshot). */
  readonly path: string;
  /** Title 38 sections in the file. */
  readonly sections: number;
  /** Title 38 appendices in the file. */
  readonly appendices: number;
  /**
   * The recorded eCFR issue date (per-title `title.38.issue_date`, legacy
   * `issue_date` as fallback), or null when the file records none.
   */
  readonly issueDate: string | null;
  /** Whether the recorded receipt still describes the current rows. */
  readonly receipt: CorpusReceiptStatus;
  /** The recorded `meta.corpus_hash`, or null when the file records none. */
  readonly recordedCorpusHash: string | null;
  /** The receipt recomputed from the store's current Title 38 rows. */
  readonly recomputedCorpusHash: string;
}

/** A missing/unreadable/non-index input is the reader's mistake, not a finding. */
function refuse(resolved: string, detail: string): ServiceError {
  return new ServiceError(`${detail} — ${resolved}`, 'invalid_input');
}

/**
 * The store's own `cannot open index at <path>: ` prefix, removed: the
 * refusal names the path itself, so the message would carry it twice.
 */
function withoutStorePrefix(detail: string, resolved: string): string {
  return detail.replace(`cannot open index at ${resolved}: `, '');
}

/**
 * Verify the index at `config.indexPath`, or the stored snapshot at
 * `snapshot`. Never creates or repairs the file; see the module doc comment.
 *
 * @throws {ServiceError} (`invalid_input`) when the path is missing or the
 *   file cannot be opened as a current-schema cfr-free index.
 */
export function runVerifyCommand(
  config: AppConfig,
  logger: Logger,
  snapshot?: string,
): VerifyReport {
  const resolved = snapshot === undefined ? config.indexPath : path.resolve(snapshot);
  if (!existsSync(resolved)) {
    throw refuse(
      resolved,
      'no index or snapshot here — run `cfr-free sync` first, or store a snapshot with `cfr-free export <path>`',
    );
  }
  let store: Store;
  try {
    // STRICT, read-only open: the same adoption contract as the offline
    // snapshot comparison — a verification never repairs or alters the file
    // it reads.
    store = Store.open(resolved, { readOnly: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw refuse(
      resolved,
      `cannot open as a cfr-free index: ${withoutStorePrefix(detail, resolved)}`,
    );
  }
  try {
    // The open itself ran PRAGMA quick_check (see Store.open), so reaching
    // here means the schema and the page structure are intact.
    const { sections, appendices } = store.countProvisions(DEFAULT_TITLE);
    // Per-title key first (multi-title indexes), the legacy key as fallback
    // for indexes built before it existed — the same resolution the offline
    // snapshot comparison uses.
    const issueDate =
      store.getMeta(`title.${DEFAULT_TITLE}.issue_date`) ?? store.getMeta('issue_date');
    // The receipt recomputed from the rows the file holds right now.
    const recomputedCorpusHash = corpusHash(store.snapshotTextHashes(DEFAULT_TITLE));
    const recordedCorpusHash = store.getMeta('corpus_hash');
    const receipt: CorpusReceiptStatus =
      recordedCorpusHash === null
        ? 'absent'
        : recordedCorpusHash === recomputedCorpusHash
          ? 'match'
          : 'mismatch';
    logger.info('index verified', {
      path: resolved,
      sections,
      appendices,
      issueDate,
      receipt,
    });
    return {
      path: resolved,
      sections,
      appendices,
      issueDate,
      receipt,
      recordedCorpusHash,
      recomputedCorpusHash,
    };
  } finally {
    store.close();
  }
}

/** Render a verification report for stdout: concise human text. */
export function formatVerifyReport(report: VerifyReport): string {
  const lines: string[] = [
    `verified ${report.path}`,
    '  schema: ok (quick_check passed)',
    `  provisions: ${report.sections} sections + ${report.appendices} appendices (Title 38)`,
    `  issue date: ${report.issueDate ?? 'none recorded'}`,
  ];
  if (report.receipt === 'match') {
    lines.push(
      '  corpus receipt: match — the recorded hash equals the receipt recomputed from the ' +
        'current Title 38 rows',
    );
  } else if (report.receipt === 'mismatch') {
    lines.push(
      '  corpus receipt: MISMATCH — the recorded receipt does not describe these rows',
      `    recorded:   ${report.recordedCorpusHash ?? ''}`,
      `    recomputed: ${report.recomputedCorpusHash}`,
    );
  } else {
    lines.push(
      '  corpus receipt: absent — the file records no corpus_hash, so the rows can be read ' +
        'but whether they are the ones a sync wrote cannot be concluded either way',
      `    recomputed from the current rows: ${report.recomputedCorpusHash}`,
    );
  }
  lines.push(`  note: ${CORPUS_RECEIPT_LIMIT}.`);
  return `${lines.join('\n')}\n`;
}
