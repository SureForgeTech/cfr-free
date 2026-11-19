# Run record — "next five features" series, `SureForgeTech/sureforge-cfr`

Session closed 2026-11-18 (MST). Checkout: `/workspace/sureforge-cfr-wire` (now on `main`,
fast-forwarded to `origin/main` = `623221f8`). Branch `fix/title-scope-nits` merged and
auto-deleted; stash cleared.

## Outcome — all merged

| PR | Title | Head reviewed | Merged | Squash commit |
| --- | --- | --- | --- | --- |
| #253 | feat(cli): compare stored snapshots offline | `eefb61ae` | 2026-11-18T22:15:11Z | `629123bb` |
| #255 | feat(sync): sync each configured CFR title into its own scope | `d7986daf` | 2026-11-18T21:46:55Z | `df62e601` |
| #256 | feat(cli): verify an index or snapshot against its corpus receipt | `4b071dd4` | 2026-11-18T22:37:50Z | `5fdcdf63` |
| #257 | feat(sections): expose structural citation support diagnostics | `b887ad96` | 2026-11-18T22:17:24Z | `032978ac` |
| #258 | feat(wire): scope search and section reads to one CFR title | `c7fb693a` → operator fixes `ced1ae4`, `3d483dd` | 2026-11-19T00:19:36Z | `d5d3ac43` |
| #262 | fix(titles): one account of the default title; cover the multi-title pin | `5782c25` → `71da311` → `83bbdc6` → `d8f0986` | 2026-11-19T06:05:33Z | `623221f8` |

#253/#255/#256/#257 were merged by the operator (`deffenda`); #258 was merged with the sandbox
app identity after the operator's two fix commits; #262 was merged by this session after an
independent fresh-context review.

## Reviews

- #253/#255/#256/#257: MiniMax M3.1 Flash reviews, no unresolved P0/P1.
- #258: review of `c7fb693a` returned REQUEST_CHANGES (P1-01: the web UI's copy block named
  Title 38 for a provision of another title). The operator fixed it on the branch in `3d483dd`
  (the copy block and the reference links now name the loaded provision's own title) and changed
  the untitled-read rule in `ced1ae4` (an untitled read looks only in Title 38; a miss is
  `not_found` with `title=N` guidance).
- #262: four rounds with the same independent reviewer (MiniMax M3.1 Flash), each on the exact
  head: `5782c25` APPROVE_WITH_NITS → `71da311` APPROVE_WITH_NITS → `83bbdc6` APPROVE_WITH_NITS →
  `d8f0986` **APPROVE** (no P0/P1/P2/nit).

## Checks

- Local gate `npm run ci` (format:check, lint, actionlint, typecheck, test:coverage, build,
  scan:audit): exit 0 on `3d483dd`, on `d8f0986` and on each #262 head. Last run: 57 files
  passed / 1 skipped, 1,208 passed / 1 skipped; statements 96.77 %, branches 90.35 %.
- GitHub CI on every merged head: `quality (22)`, `quality (24)`, `security`, `actionlint` green;
  `docker` green and cited in the PR bodies.

## Left open (documented, not blocking)

- The citation parser recognises Title 38's part numbers only (three digits), so a Title 12
  citation such as `12 CFR 1026.1` is not parsed yet — recorded in the #262 PR body as the
  follow-up for the first second title.
- The Markdown export's document header still reads "Title 38" for a file that can hold other
  titles' rows (`src/commands/export.ts:80`) — pre-existing, out of scope, recorded in #262.

## Environment notes

- The org ruleset changed mid-session: `required_approving_review_count` is now 0, so GitHub no
  longer demands an approving review; the repository's own merge floor (independent fresh-context
  review of the exact head + green required checks) was still met for every PR.
- `gh` reads the rotating token from `/var/lib/opencode-github/github.token`; `git push` needs
  `-c credential.helper=/usr/local/bin/git-credential-workspace`.
- The branch `feat/title-scoped-wire-surfaces` was pushed to by the operator during the session;
  this session's uncommitted edits on the old base were superseded, backed up to
  `/tmp/opencode/cfr-next5/local-edits-backup.patch`, and dropped.
