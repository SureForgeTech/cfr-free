/**
 * The CFR titles this service serves, and the scope a read names.
 *
 * WHY THIS FILE EXISTS. Two facts are needed by BOTH the store (which owns
 * the rows and the title scope) and the permalink builder (a pure function
 * that must not drag the SQLite-opening store in behind it): the default
 * title, and the shape of a title scope. A leaf module both sides import
 * keeps ONE account of each — the alternative was the literal 38 written in
 * two files, which is the kind of duplication the shared-rules tests exist
 * to prevent.
 *
 * The config, the eCFR client, the MCP resources and tool descriptions, the
 * export and the store's schema import the default title as well, so the
 * code names the mission title through this one constant. Two places keep
 * the number itself, and both are contracts rather than a second account:
 * the Title-38 citation prefix in `src/core/citations.ts` (that reader is
 * Title 38's by design) and the browser asset
 * (`src/titan/ui-client.js`), which is served as a standalone file and
 * cannot import this module.
 */

/**
 * The title every read path scopes to when the caller names none, and the
 * default a write stamps when a section omits its title. Title 38 (Veterans
 * Benefits) is the product's mission surface; every other title is opt-in
 * per query (multi-title design, 2026-11-13).
 */
export const DEFAULT_TITLE = 38;

/**
 * The CFR title a read is scoped to: one title number, or the literal `all`
 * (every stored title — a search-only scope; a section read names ONE
 * title, so `all` is refused there).
 */
export type TitleScope = number | 'all';
