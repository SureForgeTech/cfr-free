# Independent review packet — follow-up PR (title-scope nits)

Repository: `SureForgeTech/sureforge-cfr` (public)
Checkout: `/workspace/sureforge-cfr-wire` — branch `fix/title-scope-nits`, based on `origin/main`.
The exact head SHA under review: `5782c2595c7a403dbc87398266ae62906075badb` (read it with `git -C /workspace/sureforge-cfr-wire rev-parse HEAD`).
Base (merge base with `origin/main`): `5b05c1214e06814215415c11d0a437399630f97e`.

READ-ONLY REVIEW. Do not modify, commit, push, checkout, stash or otherwise change anything in
`/workspace/sureforge-cfr-wire`. Read the diff with git, read the files, and report. If you want to
run the tests, you may run them read-only (`npx vitest run <file>`), but do not change the tree.

## The complete Git-generated diff (no truncation)

```
diff --git a/docs/SPEC.md b/docs/SPEC.md
index e176874..f775aab 100644
--- a/docs/SPEC.md
+++ b/docs/SPEC.md
@@ -423,11 +423,22 @@ every read names the authority it answers with:
   (`32 CFR § 70.1`) settles the ambiguity on its own; a citation that names
   a different title than the read asked for is refused.
 - **The display form names the authority**: Title 38 keeps its published form
-  (`38 C.F.R. § 4.130`), every other title uses `32 CFR § 70.1`. The
-  source URLs follow the hit's own title
+  (`38 C.F.R. § 4.130`), every other title uses `32 CFR § 70.1`. An APPENDIX
+  keeps Title 38's bare name (`Appendix A to Part 4`); another title's
+  appendix reads `32 CFR Appendix A to Part 70`. The source URLs follow the
+  hit's own title
   (`…/current/title-32/section-70.1`).
-- `indexIssueDate`, `indexStale`, and any stale-index warning in `notice`
-  describe Title 38's freshness.
+- **The Title-38-only surfaces.** The title scope covers the search and the
+  section read. Every other surface still answers for Title 38 alone:
+  `/health` and `/metrics` count Title 38's rows, `browse` and `list_parts`
+  walk Title 38's structure tree, the eCFR-backed tools (`diff_issues`,
+  `redline`, `get_section_at`) fetch Title 38's XML, and the MCP resources
+  (`cfr://title38/parts`, `cfr://title38/definitions`) are Title 38's by
+  name. Making them title-scoped is a separate change.
+- `indexIssueDate` and `indexStale` describe Title 38's freshness; the
+  stale-index warning's point-in-time URL names the title the answer is
+  about — the search scope's (a `<title>` placeholder under `title=all`),
+  or the provision's own on a read.
 
 Hardening: no request bodies, zod-validated query strings, router-level byte caps (URL ≤ 2048 bytes → `414 uri_too_long`; `q` ≤ 800 bytes, `part` ≤ 10 bytes → `400`), per-peer token-bucket rate limiting (`429` + `Retry-After`) when `CFR_ALLOW_REMOTE=1` (loopback default never throttles; peers default to socket addresses, so clients behind one NAT share a budget — fine for a coarse DoS guard, not per-user fairness). The budget is spent by COST, not by request: the index-backed reads cost one token, and the two routes that pull the complete upstream document (`/api/v1/diff`, `/api/v1/redline` — ~2 MB on the wire, ~16 MB parsed) cost ten. The old one-token price bought the published budget of ten requests a second — twenty whole documents a second, because a diff or a redline pulls two of them; the ten-token price buys one such request (two documents) a second. Every request is charged BEFORE the router's own gates answer, so a refused request is not free: a request the method gate refuses (`405`), the URL-size gate refuses (`414`) or the URL parser refuses (`400`) still costs one token. Every other request is charged the ROUTE's own price — including one that is then rejected for a reason of its own (a malformed date, which the route's validation catches; a `q` over 800 bytes, which the router's byte caps catch): the price follows the path the request would have taken, so a `POST` to `/api/v1/diff` costs one token while a `GET /api/v1/diff?from=nonsense` costs ten. `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` on every response, a 60 s request timeout, a 10 s header timeout, a 5 s keep-alive timeout and a 256-connection cap (the limiter runs only after the headers are complete, so a client that dribbles them would otherwise hold a socket without spending a token), 404/405/400 with machine-readable error JSON, a `502 upstream_error` when eCFR's DATA is not usable (an unparseable date, a missing title, a missing issue date) — an upstream-data fault is neither the reader's fault nor ours, so it is a bad gateway rather than a generic 500, and the detail stays in the server log, `Cache-Control: max-age=3600` on section reads (content only changes on amendment); the two eCFR-fetching routes cache their responses at shorter ceilings (`diff` `max-age=3600`, `redline` `max-age=300` — a redline spans two upstream fetches and the from/to window is only rarely an identical document). The upstream document fetches are bounded on BOTH sides, because a request budget bounds how fast they START and nothing bounded how many could run at once: a semaphore lets four run at a time and refuses a request whose wait queue is full (sixteen waiting) with `503 upstream_busy` — refused at once rather than parked for minutes — and the fetched documents are memoised by issue date (the same date is the same document) in a per-process, in-memory memo that keeps at most four documents for five minutes; concurrent readers of the same date share ONE upstream fetch. The three index-backed reads (`/api/v1/search`, `/api/v1/sections/:citation`, `/api/v1/browse`) also carry a **strong `ETag`** — a quoted sha256 over the exact response bytes, so the tag changes if and only if the body changes — and answer a matching `If-None-Match` with a bodyless `304` (RFC 9110 §13.1.2: `*` matches any representation, a list matches when any member matches, and a weak validator `W/"x"` matches the strong `"x"`), so a client can confirm the text it quotes is unchanged without re-downloading it. Only a 200 is eligible: `/health`, `/metrics`, the two eCFR-fetching routes and every error response carry no validator and are never a 304. No auth — documented as localhost-only; `HOST` env can override deliberately (with the rate budget attached). A loopback bind is also guarded against the browser on the same machine: a page can point a name it controls at `127.0.0.1` (DNS rebinding) and then read every answer as its own origin, so a request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` (ports and case ignored; `localhost.`, `0.0.0.0` and other `127.x` addresses are NOT accepted) is refused with `421 misdirected_request`. A reverse proxy on the same machine that forwards the public name lists it in `CFR_ALLOWED_HOSTS` (comma-separated host names); a request with no `Host` at all (HTTP/1.0) is served, because a browser always sends one. Loopback binds and remote binds with `CFR_ALLOWED_HOSTS` refuse `Sec-Fetch-Site: cross-site` with `403 forbidden` to prevent a third-party page from spending upstream fetches. Remote binds without `CFR_ALLOWED_HOSTS` accept cross-site navigation and arbitrary host names. The container's host-side published port stays on loopback (§7).
 
diff --git a/src/config.ts b/src/config.ts
index 8da08dc..7a4a8b6 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -2,6 +2,7 @@ import net from 'node:net';
 import os from 'node:os';
 import path from 'node:path';
 import { z } from 'zod';
+import { DEFAULT_TITLE } from './core/titles.js';
 import type { LogLevel } from './logger.js';
 
 /** Raised when the process environment fails validation. */
@@ -58,9 +59,6 @@ export function isLoopbackHost(host: string): boolean {
 const DEFAULT_MAX_AGE_DAYS = 7;
 const DEFAULT_PORT = 8787;
 
-/** The CFR title this service is built around; every read surface defaults to it. */
-export const DEFAULT_CFR_TITLE = 38;
-
 /** String-only schema; numeric fields are converted and bounds-checked below. */
 const envSchema = z.object({
   CFR_INDEX_PATH: z.string().min(1).optional(),
@@ -123,7 +121,7 @@ function hostNames(list: string): string[] {
  * default [38]; a title number outside 1-50 is a startup failure.
  */
 function parseTitles(raw: string | undefined): readonly number[] {
-  if (raw === undefined) return [38];
+  if (raw === undefined) return [DEFAULT_TITLE];
   const titles = raw
     .split(',')
     .map((entry) => entry.trim())
@@ -137,7 +135,7 @@ function parseTitles(raw: string | undefined): readonly number[] {
       }
       return title;
     });
-  if (titles.length === 0) return [38];
+  if (titles.length === 0) return [DEFAULT_TITLE];
   return [...new Set(titles)].sort((a, b) => a - b);
 }
 
@@ -153,8 +151,8 @@ function parseTitles(raw: string | undefined): readonly number[] {
  * left to each caller's loop.
  */
 export function titleSyncOrder(titles: readonly number[]): readonly number[] {
-  const rest = titles.filter((title) => title !== DEFAULT_CFR_TITLE).sort((a, b) => a - b);
-  return titles.includes(DEFAULT_CFR_TITLE) ? [DEFAULT_CFR_TITLE, ...rest] : rest;
+  const rest = titles.filter((title) => title !== DEFAULT_TITLE).sort((a, b) => a - b);
+  return titles.includes(DEFAULT_TITLE) ? [DEFAULT_TITLE, ...rest] : rest;
 }
 
 function parseBoundedInt(
diff --git a/src/core/titles.ts b/src/core/titles.ts
index 5cf650e..2414487 100644
--- a/src/core/titles.ts
+++ b/src/core/titles.ts
@@ -8,6 +8,9 @@
  * keeps ONE account of each — the alternative was the literal 38 written in
  * two files, which is the kind of duplication the shared-rules tests exist
  * to prevent.
+ *
+ * The config imports the default title as well (`CFR_TITLES` defaults to the
+ * mission title), so the number 38 is written ONCE in the source tree.
  */
 
 /**
diff --git a/test/multi-title-wire.test.ts b/test/multi-title-wire.test.ts
index 4fab733..4be89d4 100644
--- a/test/multi-title-wire.test.ts
+++ b/test/multi-title-wire.test.ts
@@ -154,6 +154,24 @@ describe('the title-scoped search', () => {
     }
   });
 
+  it('pins every title’s copy of an untitled citation under `all`', () => {
+    const temp = openMultiTitleStore();
+    try {
+      const { hits } = serviceOver(temp).search({ query: '70.1', title: 'all' });
+      // The citation names no title, so EVERY title that holds it is pinned,
+      // each labeled with its own authority. The ambiguity rule belongs to
+      // the READ (which answers with one provision), not to a cross-title
+      // search (which answers with a list).
+      const pinned = hits.filter((hit) => hit.direct);
+      expect(pinned.map((hit) => `${hit.title}:${hit.citation}`).sort()).toEqual([
+        '32:70.1',
+        '38:70.1',
+      ]);
+    } finally {
+      temp.cleanup();
+    }
+  });
+
   it.each([
     { query: '32 CFR 70.1', title: undefined, citedTitle: 32 },
     { query: '38 CFR 70.1', title: 32, citedTitle: 38 },

```

## What the change is for

Follow-up to the merged #258 ("feat(wire): scope search and section reads to one CFR title"). The
review of that PR named three findings that the PR (and the two fix commits that followed on the
branch) did not close:

- **N4 — one account of the default title.** `src/config.ts` declared `DEFAULT_CFR_TITLE = 38`
  while `src/core/titles.ts` declares `DEFAULT_TITLE = 38`. The same fact twice, free to drift.
- **N5 — the multi-title pin had no test.** A `title=all` search whose query is a citation that
  names NO title pins EVERY title's copy, each labeled with its own authority. No test covered that
  branch (the existing `title=all` test used a citation that NAMES a title, which takes a different
  branch).
- **N7 — SPEC §5 did not name the Title-38-only surfaces**, and did not state the appendix display
  form or which title the stale-index warning's point-in-time URL names.

## Acceptance criteria

1. The default CFR title has exactly one source of truth in `src/`: `src/core/titles.ts`
   `DEFAULT_TITLE`. `src/config.ts` imports it; no second literal/constant remains, and nothing
   referenced `DEFAULT_CFR_TITLE` (verified by grep over the tree: no references).
2. `CFR_TITLES` parsing and `titleSyncOrder` keep their behaviour (default `[38]`, Title 38 first
   then the rest ascending).
3. The new test asserts the documented behaviour of the untitled multi-pin under `title=all`: every
   title that holds the citation is pinned, each labeled with its own title; the pins are the
   `direct` hits.
4. SPEC §5's statements match the implementation:
   - `/health` and `/metrics` count Title 38's rows (`service.countSections(DEFAULT_TITLE)`);
   - `browse` and `list_parts` walk Title 38's structure tree (`service.browse`,
     `service.partTitleMap(DEFAULT_TITLE)`);
   - the eCFR-backed tools (`diff_issues`, `redline`, `get_section_at`) fetch Title 38's XML
     (`EcfrApi.getFullTitleXml(issueDate, title = TITLE_38)`);
   - the MCP resources `cfr://title38/parts` and `cfr://title38/definitions` are Title 38's;
   - the display form: Title 38 keeps `38 C.F.R. § 4.130` and the bare appendix name; another
     title uses `32 CFR § 70.1` and `32 CFR Appendix A to Part 70`
     (`service.displayCitation`);
   - the stale-index warning's point-in-time URL names the title the answer is about — the search
     scope's (a `<title>` placeholder under `title=all`), or the provision's own on a read
     (`service.noticeFor(status, scope)` / `noticeFor(status, row.title)`).
5. No behaviour change: the constant is the same value; the new test asserts behaviour that already
   existed; the SPEC change states what the code already does.
6. The repository's own gate passes: `npm run ci`.

## Validation actually run on the reviewed tree

- `npm run ci` — exit 0 (format:check, lint, actionlint, typecheck, test:coverage, build,
  scan:audit).
- Focused: `npx vitest run test/multi-title-wire.test.ts` — 39 passed; the four documentation tests
  (`markdown-tables`, `no-conflict-markers`, `openapi-conformance`, `install-paths`) — 148 passed.
- Test/coverage totals are in the PR body; CI (quality 22 / quality 24 / security / actionlint) is
  green on the head.

## What to check

- Whether the three changes do what they claim, and whether any of them breaks a caller (the config
  is imported by the CLI and the HTTP server; `DEFAULT_TITLE` lives in a leaf module, so the import
  direction must not create a cycle — `test/import-cycles.test.ts` checks that).
- Whether the new test really exercises the untitled multi-pin branch (not the titled one).
- Whether the SPEC statements are true of THIS tree (read the code, do not take the bullet on
  trust).
- Anything that would be a P0 or P1: a wrong authority in an answer, a false statement in SPEC,
  a broken gate, a lost behaviour.

## Report format

End with one line: `VERDICT: APPROVE` | `VERDICT: APPROVE_WITH_NITS` | `VERDICT: REQUEST_CHANGES`.

List findings as `P0`/`P1`/`P2`/`nit`, each with `file:line`, what is wrong, and how to reproduce it.
If a finding is only a style preference, say so as a nit. Do not restate the acceptance criteria as
findings; only report what you verified or can point at.
