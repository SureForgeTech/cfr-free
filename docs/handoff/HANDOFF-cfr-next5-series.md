# HANDOFF — cfr-next5-series

## Goal

Land the five-feature "next five features" series (`SureForgeTech/sureforge-cfr`, PRs #253–#258)
with each PR independently reviewed, and land the review nits that survived. **This goal is
complete**: all six pull requests are merged into `main`.

## What is done, and whether it is tested

| PR | Title | Merged | Squash commit on `main` |
| --- | --- | --- | --- |
| #253 | feat(cli): compare stored snapshots offline | by `deffenda` | `629123bb` |
| #255 | feat(sync): sync each configured CFR title into its own scope | by `deffenda` | `df62e601` |
| #256 | feat(cli): verify an index or snapshot against its corpus receipt | by `deffenda` | `5fdcdf63` |
| #257 | feat(sections): expose structural citation support diagnostics | by `deffenda` | `032978ac` |
| #258 | feat(wire): scope search and section reads to one CFR title | 2026-11-19T00:19Z | `d5d3ac43` |
| #262 | fix(titles): one account of the default title; cover the multi-title pin | 2026-11-19T06:05Z | `623221f8` |

- **Tested:** every merged head passed the local gate `npm run ci` (format:check, lint, actionlint,
  typecheck, test:coverage, build, scan:audit) — exit 0. Final run: 57 test files passed /
  1 skipped, 1,208 tests passed / 1 skipped; statements 96.77 %, branches 90.35 %. GitHub CI green
  on every merged head (`quality (22)`, `quality (24)`, `security`, `actionlint`; `docker` green
  as well and cited in the PR bodies).
- **Reviewed:** #253/#255/#256/#257 — MiniMax M3.1 Flash, no unresolved P0/P1. #258 — the review
  of `c7fb693a` returned REQUEST_CHANGES (P1-01: the web UI's copy block named Title 38 for a
  provision of another title); the operator fixed it on the branch (`ced1ae4` untitled reads look
  only in Title 38 and return `not_found` with `title=N` guidance; `3d483dd` the copy block and
  reference links name the loaded provision's own title). #262 — four independent fresh-context
  review rounds on the exact head chain `5782c25` → `71da311` → `83bbdc6` → `d8f0986`; the final
  verdict is **APPROVE** (no P0, P1, P2 or nit).

## What is half-done

Nothing. There is no unfinished edit in any checkout, and no open pull request (verified:
`gh pr list --state open` is empty).

Two follow-ups are known and deliberately left out of scope, both recorded in PR #262's body:

1. The citation parser recognises Title 38's part numbers only (three digits), so a Title 12
   citation such as `12 CFR 1026.1` is not parsed yet — `src/core/citations.ts:15`
   (`SECTION_RE = /^\d{1,3}\.\d{1,4}[a-z]{0,3}$/i`). It is the follow-up for the first second title.
2. The Markdown export's document header still reads "Title 38" for a file that can hold other
   titles' rows — `src/commands/export.ts:80`. Pre-existing, untouched by this series.

## Exact next step

None required. If someone picks this up: read `wip/cfr-next5-series/run-record.md` on the
`wip/cfr-next5-series` branch for the full session record, and treat items 1 and 2 above as the
candidate follow-ups. The archive branch must **not** be merged or turned into a pull request.

## Branch, latest commit, pull request

- Working branch: `wip/cfr-next5-series` (archive branch, pushed to origin).
- Latest commit on it: see the reply line below (`WIP: archive the "next five features" session
  artifacts`), parent `623221f8` (`main`).
- The checkout `/workspace/sureforge-cfr-wire` was left on `wip/cfr-next5-series`; `main` is
  untouched at `623221f8`.
- **Open pull requests: none.** The six PRs of the series (#253, #255, #256, #257, #258, #262) are
  all merged.

## Decisions made, and why

- **PR #258's P1-01 was fixed title-aware, not by pinning the UI to Title 38.** The operator's
  `3d483dd` builds the copy block and the reference links from the loaded provision's own `title`,
  so a Title 32 provision is never labelled `38 C.F.R.`. This supersedes this session's earlier
  plan (hardcoded Title-38 forms + `?title=38` on the UI read); the superseded edits are kept in
  `wip/cfr-next5-series/local-edits-backup.patch` and were never pushed.
- **An untitled section read looks only in Title 38** (`ced1ae4`) and a miss is `not_found` naming
  the other titles holding the citation — no silent cross-title answer, and no ambiguity error.
- **The search pin never crosses the scope**: a citation naming a title outside the search scope is
  not pinned, and the response's `notice` suggests `title=N`.
- **The default CFR title has one account** (#262): `DEFAULT_TITLE` in `src/core/titles.ts`; the
  config, the eCFR client (`TITLE_38`), the MCP resource and tool description, the export and the
  store's schema column defaults all derive from it. Two contracts still keep the number — the
  Title-38 citation prefix and the standalone browser asset — and the comment names both.
- **One review round per changed head, same independent reviewer** (MiniMax M3.1 Flash): the
  repository's floor is a fresh-context review of the exact head, so each pushed commit was
  reviewed again.
- **The org ruleset changed mid-session** (`required_approving_review_count` 1 → 0), so GitHub no
  longer demands an approving review. The repository's own floor was still met for every PR.

## Blockers

None. Nothing failed in this session's final stretch; the GitHub token rotates hourly and lives in
`/var/lib/opencode-github/github.token` (the `gh` wrapper reads it; `git push` needs
`-c credential.helper=/usr/local/bin/git-credential-workspace`). An earlier rotation briefly served
an invalid token, which surfaced as:

```
gh: Bad credentials (HTTP 401)
```

and later as `Resource not accessible by integration (HTTP 403)` for `gh api user` — the latter is
expected for an app installation token and is not an error.

## Ignored / untracked files that matter

`git status --ignored --short` in `/workspace/sureforge-cfr-wire`:

```
!! coverage/     (local coverage report from `npm run test:coverage` — regenerable)
!! dist/         (local build output from `npm run build` — regenerable)
!! node_modules/ (dependencies — regenerable)
```

Nothing untracked remains on the branch: the session artifacts that used to live only in
`/tmp/opencode/cfr-next5/` (run record, review packet, PR body, superseded patches, CI logs) are
committed under `wip/cfr-next5-series/` on the pushed archive branch. No stash entries exist
(`git stash list` is empty). The only worktree is `/workspace/sureforge-cfr-wire`; the other
checkouts under `/workspace` are separate clones, not worktrees of this repository.
