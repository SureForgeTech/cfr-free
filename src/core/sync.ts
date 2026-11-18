import {
  CHANGE_LIST_CAP,
  corpusHash,
  diffHashes,
  hashContent,
  type SyncChanges,
} from './changes.js';
import type { Logger } from '../logger.js';
import type { EcfrApi } from './ecfr.js';
import { TITLE_38 } from './ecfr.js';
import { DEFAULT_TITLE, type Store } from './store.js';
import { countNodes, parseStructure, type StructureNode } from './structure.js';
import { IMAGE_MARKER_PREFIX, parseTitleXml, type RawSection } from './xml.js';

/**
 * Full index build: resolve the issue date, pull structure + full-title XML,
 * parse, then atomically replace the title's slice of the store contents in
 * one transaction. Title 38 is the default authority and the only title the
 * legacy global meta keys describe; every title additionally gets its own
 * `title.<N>.*` meta keys.
 */

/** Bump when the parsing contract changes (recorded in `meta`).
 *  v2: numeric character references (`&#xA7;` → §) are now decoded. */
export const PARSER_VERSION = '2';

/** Raised when a sync cannot produce a usable index. */
export class SyncError extends Error {
  override readonly name = 'SyncError';
}

export interface SyncDeps {
  readonly ecfr: EcfrApi;
  readonly store: Store;
  readonly logger: Logger;
  /** The CFR title to sync (default {@link TITLE_38}). */
  readonly title?: number;
}

export interface SyncReport {
  /** The CFR title this report describes (default {@link TITLE_38}). */
  readonly title: number;
  readonly issueDate: string;
  readonly sections: number;
  readonly appendices: number;
  readonly durationMs: number;
  /** Provision-level delta versus the previous index (counts only). */
  readonly changes: { readonly changed: number; readonly added: number; readonly removed: number };
  /**
   * Provisions whose text carries at least one "image content not included"
   * marker (review finding P1-01). These provisions are NOT textually
   * complete: their eCFR graphics (the rating tables) are absent and are
   * flagged in place, so a matching section count never implies complete
   * textual coverage.
   */
  readonly imageContentSections: number;
  /**
   * The corpus receipt: sha256 over every provision's (citation,
   * content-hash) pair — content = text + heading, the change-diff unit
   * (SPEC §4). Together with the issue date it identifies the provisions
   * the index was rebuilt from, so two retrieval runs are comparable only
   * when their receipts agree.
   */
  readonly corpusHash: string;
}

/**
 * Count the provisions that carry at least one image marker. The marker is
 * emitted by the parser, so the count is derived from the parsed corpus —
 * never guessed.
 */
function countImageContentSections(sections: readonly RawSection[]): number {
  let count = 0;
  for (const section of sections) {
    if (section.text.includes(IMAGE_MARKER_PREFIX)) count += 1;
  }
  return count;
}

function countKinds(sections: readonly RawSection[]): { sections: number; appendices: number } {
  let sectionCount = 0;
  let appendixCount = 0;
  for (const section of sections) {
    if (section.kind === 'appendix') appendixCount += 1;
    else sectionCount += 1;
  }
  return { sections: sectionCount, appendices: appendixCount };
}

function verifyAgainstStructure(
  sections: readonly RawSection[],
  structure: StructureNode,
  logger: Logger,
): { expectedSections: number; expectedAppendices: number } {
  const expectedSections = countNodes(structure, 'section');
  const expectedAppendices = countNodes(structure, 'appendix');
  const actual = countKinds(sections);
  if (actual.sections !== expectedSections || actual.appendices !== expectedAppendices) {
    logger.warn('parsed counts differ from structure tree', {
      expectedSections,
      actualSections: actual.sections,
      expectedAppendices,
      actualAppendices: actual.appendices,
    });
  }
  // Expected counts are persisted so later readers can detect drift (delivery log §13).
  return { expectedSections, expectedAppendices };
}

/**
 * Derive the provision-level change report from the baseline snapshot.
 *
 * Runs INSIDE the rebuild transaction (see `Store.replaceTitleWithBaseline`):
 * every input here must come from that in-transaction snapshot or from OUR
 * own freshly parsed sections — nothing may be read before BEGIN IMMEDIATE,
 * or a concurrent sync could commit its own index in between and the report
 * would describe a baseline this sync never replaced.
 */
function buildChanges(input: {
  readonly previousIssueDate: string | null;
  readonly previousParser: string | null;
  readonly oldHashes: ReadonlyMap<string, string>;
  readonly newHashes: ReadonlyMap<string, string>;
  readonly issueDate: string;
}): SyncChanges {
  const { previousIssueDate, previousParser, oldHashes, newHashes, issueDate } = input;
  const baseline = oldHashes.size === 0;
  const diff = diffHashes(oldHashes, newHashes);
  return baseline
    ? {
        fromIssueDate: null,
        toIssueDate: issueDate,
        changed: 0,
        added: 0,
        removed: 0,
        changedCitations: [],
        addedCitations: [],
        removedCitations: [],
        baseline: true,
        parserChanged: false,
        recordedAt: new Date().toISOString(),
      }
    : {
        fromIssueDate: previousIssueDate,
        toIssueDate: issueDate,
        changed: diff.changed.length,
        added: diff.added.length,
        removed: diff.removed.length,
        changedCitations: diff.changed.slice(0, CHANGE_LIST_CAP),
        addedCitations: diff.added.slice(0, CHANGE_LIST_CAP),
        removedCitations: diff.removed.slice(0, CHANGE_LIST_CAP),
        baseline: false,
        parserChanged: previousParser !== PARSER_VERSION,
        recordedAt: new Date().toISOString(),
      };
}

/** Build (or rebuild) one title's slice of the local index from live eCFR data. */
export async function syncIndex(deps: SyncDeps): Promise<SyncReport> {
  const startedAt = Date.now();
  const { ecfr, store, logger } = deps;
  const title = deps.title ?? TITLE_38;

  logger.info('resolving eCFR issue date', { title });
  const schedule = await ecfr.getTitleSchedule(title);
  const issueDate = schedule.upToDateAsOf;

  logger.info('fetching title structure', { title, issueDate });
  const structureRaw = await ecfr.getStructureJson(issueDate, title);
  const structure = parseStructure(structureRaw);

  logger.info('fetching full title XML', { title, issueDate });
  const xml = await ecfr.getFullTitleXml(issueDate, title);

  const sections = parseTitleXml(xml);
  if (sections.length === 0) {
    throw new SyncError(
      `parsed zero sections for title ${title} — eCFR XML format may have changed (see docs/SPEC.md §3)`,
    );
  }
  const expected = verifyAgainstStructure(sections, structure, logger);
  const counts = countKinds(sections);
  const imageContentSections = countImageContentSections(sections);

  // newHashes for the diff: computed from OUR own parsed XML, so it is safe
  // to do outside the transaction (~2 970 sha256 hashes — real CPU time we
  // must not hold the write lock for). The rebuild transaction below then
  // only snapshots the outgoing slice and swaps rows.
  const newHashes = new Map<string, string>();
  for (const section of sections) {
    // Text AND heading — a retitled provision with an unchanged body is a
    // change (see hashContent).
    newHashes.set(section.citation, hashContent(section.text, section.heading));
  }

  // Every title carries its own `title.<N>.*` meta keys; Title 38 ALSO keeps
  // the legacy global keys (`issue_date`, `structure_json`, counts,
  // `corpus_hash`, `last_changes`) that the existing read surfaces
  // (service.status, MCP index_status, /health) still read. A Title 32 sync
  // therefore never stomps the global keys a Title 38 reader depends on.
  const meta: Record<string, string> = {
    [`title.${title}.issue_date`]: issueDate,
    [`title.${title}.synced_at`]: new Date().toISOString(),
    [`title.${title}.appendices_count`]: String(counts.appendices),
    // Provisions whose eCFR graphics are NOT included (P1-01): persisted so
    // a later reader can tell the index is not textually complete.
    [`title.${title}.image_content_sections`]: String(imageContentSections),
    [`title.${title}.structure_expected_sections`]: String(expected.expectedSections),
    [`title.${title}.structure_expected_appendices`]: String(expected.expectedAppendices),
    [`title.${title}.structure_json`]: JSON.stringify(structureRaw),
    [`title.${title}.parser_version`]: PARSER_VERSION,
    // The report commits atomically with the index it describes (batch-4
    // R4): filled from the in-transaction snapshot below, BEFORE the meta
    // upserts run — so it still rides the SAME rebuild COMMIT.
  };
  if (title === DEFAULT_TITLE) {
    Object.assign(meta, {
      issue_date: issueDate,
      synced_at: meta[`title.${title}.synced_at`],
      appendices_count: String(counts.appendices),
      image_content_sections: String(imageContentSections),
      structure_expected_sections: String(expected.expectedSections),
      structure_expected_appendices: String(expected.expectedAppendices),
      structure_json: JSON.stringify(structureRaw),
      parser_version: PARSER_VERSION,
    });
  }

  // The corpus receipt (SPEC §4): a sha256 over the whole corpus's
  // per-provision content hashes. Per title: one receipt describes one
  // authority's corpus, so a Title 32 rebuild moves only `title.32.corpus_hash`.
  // Title 38 additionally keeps the legacy global receipt its readers use.
  // Both ride the SAME meta object the rebuild upserts, so this rebuild path
  // cannot commit rows without the receipts that describe them.
  const titleCorpusHash = corpusHash(newHashes);
  meta[`title.${title}.corpus_hash`] = titleCorpusHash;
  if (title === DEFAULT_TITLE) {
    meta.corpus_hash = titleCorpusHash;
  }

  // The baseline snapshot (previous issue date, previous parser, outgoing
  // text hashes) is taken INSIDE the rebuild transaction by the callback,
  // scoped to THIS title: between a pre-transaction snapshot and
  // BEGIN IMMEDIATE a second `cfr-free sync` could commit its own index,
  // making this report describe a baseline we never actually replaced
  // (scout #3 / batch-5 R3) — and a sibling title's rows are never this
  // title's added/removed baseline.
  const changes: SyncChanges = store.replaceTitleWithBaseline(
    title,
    sections,
    issueDate,
    meta,
    (snapshot) => {
      const oldHashes = snapshot.snapshotTextHashes(title);
      // First sync after the per-title keys arrived may face an index whose
      // only record is the legacy global pair — read it as Title 38's
      // baseline so the change report keeps its continuity.
      const legacy = title === DEFAULT_TITLE;
      const built = buildChanges({
        previousIssueDate:
          snapshot.getMeta(`title.${title}.issue_date`) ??
          (legacy ? snapshot.getMeta('issue_date') : null),
        previousParser:
          snapshot.getMeta(`title.${title}.parser_version`) ??
          (legacy ? snapshot.getMeta('parser_version') : null),
        oldHashes: oldHashes.size > 0 ? oldHashes : new Map<string, string>(),
        newHashes,
        issueDate,
      });
      const serialized = JSON.stringify(built);
      meta[`title.${title}.last_changes`] = serialized;
      if (legacy) meta.last_changes = serialized;
      return built;
    },
  );

  const report: SyncReport = {
    title,
    issueDate,
    sections: counts.sections,
    appendices: counts.appendices,
    durationMs: Date.now() - startedAt,
    changes: { changed: changes.changed, added: changes.added, removed: changes.removed },
    imageContentSections,
    corpusHash: titleCorpusHash,
  };
  logger.info('index rebuilt', { ...report });
  return report;
}
