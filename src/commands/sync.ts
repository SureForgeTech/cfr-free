import { titleSyncOrder, type AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { Store } from '../core/store.js';
import type { SyncReport } from '../core/sync.js';
import { createEcfrApi, syncWithGuidance, type EnsureIndexDeps } from './ensure-index.js';

/**
 * `cfr-free sync` — force a full rebuild of the local index.
 *
 * Every `config.titles` entry is synced SEQUENTIALLY, 38 first then
 * ascending (the config's order): each sync commits its own title's rows
 * and meta in one transaction before the next title starts, so a failure
 * in a later title leaves the earlier titles' fresh rows committed. One
 * shared eCFR client serves all titles — its document memo is keyed by
 * title+date, so no document is fetched twice.
 */
export async function runSyncCommand(
  config: AppConfig,
  logger: Logger,
  deps: EnsureIndexDeps = {},
): Promise<SyncReport[]> {
  // allowSchemaUpgrade: sync's whole job is a wholesale rebuild, so it may
  // adopt an older on-disk schema version (syncIndex repopulates every row,
  // including the section_references edges) instead of refusing to open the
  // very file it exists to rebuild. Downgrades still fail inside open().
  const store = Store.open(config.indexPath, { allowSchemaUpgrade: true });
  try {
    const ecfr = (deps.createEcfr ?? createEcfrApi)();
    const reports: SyncReport[] = [];
    for (const title of titleSyncOrder(config.titles)) {
      // No next step: the reader IS `cfr-free sync`, so telling them to run
      // `cfr-free sync` again would be circular. The advice that comes with
      // the failure says what to do instead.
      reports.push(await syncWithGuidance({ ecfr, store, logger, title }, logger, ''));
    }
    return reports;
  } finally {
    store.close();
  }
}
