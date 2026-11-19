## Summary

Follow-up to #258 (and to the review of the #258 series). Three gaps the #258 review named that no
later change closed — none of them changes behaviour:

- **One account of the default title.** `src/config.ts` declared `DEFAULT_CFR_TITLE = 38` while
  `src/core/titles.ts` declares `DEFAULT_TITLE = 38` — the same fact in two places, free to drift.
  The config, the eCFR client (`TITLE_38`), the MCP resource and tool description, the export's
  title comparison and the store's schema column defaults now all take the value from
  `DEFAULT_TITLE`. Two places still keep the number, and both are contracts rather than a second
  account: the Title-38 citation prefix in `src/core/citations.ts` and the browser asset
  `src/titan/ui-client.js` (served standalone, so it cannot import the module). Nothing referenced
  `DEFAULT_CFR_TITLE` (grep over the tree: no references).
- **The multi-title pin is covered.** A `title=all` search whose query is a citation that names NO
  title pins every title's copy, each labeled with its own authority. That branch had no test: the
  existing `title=all` test used a citation that NAMES a title, which takes a different branch.
- **SPEC §5 names the Title-38-only surfaces** (`/health` and `/metrics` count Title 38's rows,
  `browse` and `list_parts` walk Title 38's structure tree, the eCFR-backed tools fetch Title 38's
  XML, the MCP resources are Title 38's by name — the CLI's export is not among them: it writes
  every stored title's rows), states the appendix display form (`32 CFR Appendix A to Part 70`;
  Title 38 keeps the bare name) and says which title the stale-index warning's point-in-time URL
  names.

## Validation

- `npm run ci` — exit 0 (format:check, lint, actionlint, typecheck, test:coverage, build,
  scan:audit) on `d8f0986`
- Tests: **57 files passed / 1 skipped; 1,208 passed / 1 skipped** (1 new test in
  `test/multi-title-wire.test.ts`)
- Coverage: statements 96.77 %, branches 90.35 %, functions 98.10 %, lines 98.11 %
- Focused: `npx vitest run test/store.test.ts test/mcp-server.test.ts test/config.test.ts
  test/multi-title-wire.test.ts test/export.test.ts` — 199 passed; the four documentation tests
  (`markdown-tables`, `no-conflict-markers`, `openapi-conformance`, `install-paths`) — 148 passed
- CI on the head: `quality (22)`, `quality (24)`, `security`, `actionlint` — green; `docker` green
  as well.

## Review

Independent fresh-context review of the exact head (MiniMax M3.1 Flash), four rounds on this head
chain — the reviewer re-derived each verdict from the code:

- Round 1 (`5782c25`): APPROVE_WITH_NITS — no P0/P1; one P2 (a comment claimed the number 38 was
  written once while `src/core/ecfr.ts` still declared its own `TITLE_38 = 38`) and one nit (the
  SPEC bullet over-reached: the CLI's export writes every stored title's rows).
- Round 2 (`71da311`): APPROVE_WITH_NITS — the nit closed; the P2's wording was still not true
  (`src/mcp/resources.ts` passed the literal `38`; the store's schema kept `DEFAULT 38`).
- Round 3 (`83bbdc6`): APPROVE_WITH_NITS — the resource reads the constant now; the comment's
  inventory was still incomplete (`src/core/citations.ts`, `src/mcp/tools.ts`).
- Round 4 (`d8f0986`): **APPROVE** — no P0, P1, P2 or nit. The reviewer verified independently
  that the rendered schema SQL is byte-identical to the previous head, that an existing on-disk
  index is unaffected, that the v2→v3 migration path behaves identically, and that the MCP tool
  description is unchanged.

## Notes

- Based on `main` (`5b05c12`), independent of #258 — it only touches the three things above.
- The citation parser still recognises Title 38's part numbers only (up to three digits), so a
  Title 12 citation such as `12 CFR 1026.1` is not parsed yet. That is a deliberate follow-up for
  the first second title, not part of this change.
- Pre-existing and out of scope: the Markdown export's document header still reads "Title 38" for a
  file that may hold other titles' rows (`src/commands/export.ts:80`).
