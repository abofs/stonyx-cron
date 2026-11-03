# Release Process

This package follows the Stonyx shared release pipeline in
[abofs/stonyx-workflows](https://github.com/abofs/stonyx-workflows). The steps below
are verified against this repo's `.github/workflows/ci.yml`, `publish.yml`,
`security-audit.yml`, and `package.json`'s `prepublishOnly`, plus the reusable
workflow definitions they call (`ci.yml`, `npm-publish.yml`, `security-audit.yml` in
`abofs/stonyx-workflows`, read 2026-11-02) — not copied from `stonyx-workflows/docs`
without checking against what this repo's workflow files actually invoke.

**npm package:** `@stonyx/cron`

## CI (`.github/workflows/ci.yml`)

Runs on every PR targeting `dev`, `main`, or `fix/**`. Delegates entirely to
`abofs/stonyx-workflows/.github/workflows/ci.yml@main`, which on the runner:

1. Checks out with `persist-credentials: false` (so the job's `GITHUB_TOKEN` is never
   written into `.git/config` for the consumer's own install/test scripts to read).
2. `pnpm install --frozen-lockfile`
3. `pnpm test` — for this repo, `pnpm build && NODE_ENV=test node --import tsx/esm
   --import ./test/setup.ts node_modules/qunit/bin/qunit.js 'test/**/*-test.ts'`.
4. `pnpm run --if-present build` — a second, explicit build step whose purpose is a
   docs-import check: every import a consumer can copy out of README/docs must resolve
   against the package's real exports. (Already covered here because `pnpm test`
   builds first, but the reusable workflow runs it unconditionally since not every
   `@stonyx/*` consumer's `pnpm test` builds.)

Locally, the equivalent is:

```bash
pnpm install --frozen-lockfile
pnpm test
```

Verified by running both in this working tree: install completed with no lockfile
changes, and `pnpm test` passed 200/200 (`# pass 200`, `# fail 0`), including the
`CronService — phase split (#34)` suite and the legacy/advanced-scheduling integration
tests. No fake-timer-related failures were observed.

## Publish (`.github/workflows/publish.yml`)

Triggers: `repository_dispatch` (`cascade-publish`, fired by a sibling package's
release), `workflow_dispatch` (manual, with `version-type` or `custom-version`), and
`pull_request`/`push` on `dev`/`main`. It calls two reusable workflows with
`secrets: inherit`:

- `npm-publish.yml` — does the version bump, test run, pack, publish, and tag/push.
- `cascade.yml` (needs `publish`) — propagates the newly published version to
  dependent `@stonyx/*` packages.

Verified from the reusable `npm-publish.yml` source (not inferred from this repo's
thin wrapper alone):

- **Version channel is derived from the trigger**, not hardcoded: PR → `alpha`; push to
  a non-`main` branch, or a cascade dispatch → `beta`; push to `main` → `stable`
  (`patch` bump); `workflow_dispatch` → whatever `version-type`/`custom-version` was
  given.
- **Runs `pnpm install` and `pnpm test` again** inside the publish job (with
  `--no-frozen-lockfile` only in cascade mode, otherwise `--frozen-lockfile`), so this
  repo's `prepublishOnly: "npm test"` is redundant with, not instead of, that step —
  `prepublishOnly` fires again inside the packing step below.
- **Packs once to a guarded tarball, not a directory.** The "Pack and guard the release
  artifact" step runs `pnpm pkg get scripts.prepublishOnly` and, if present, runs it
  (`pnpm run prepublishOnly`, i.e. `npm test` a third time counting the earlier `pnpm
  test`), then `pnpm pack --pack-destination "$RUNNER_TEMP/stonyx-pack"`, and inspects
  the resulting tarball's entry list for exactly this repo's historical defect: any path
  matching `^package/(.*/)?\.git(/|$)`. A match aborts the publish. The three `pnpm
  publish` steps below publish that exact tarball path, never a re-pack of the tree.
- **Publishes via `pnpm publish <tarball> --tag <alpha|beta|(none)> --access public
  --no-git-checks`**, authenticated through GitHub OIDC trusted publishing (no static
  npm token in this org) — consistent with this repo's `publishConfig.provenance: true`.
- **Commits the version bump and pushes a tag** (`v<version>`) back to the triggering
  branch, authenticated with a short-lived token applied per-`git`-invocation via
  `GIT_CONFIG_*` rather than written to `.git/config` or a remote URL — the fix for the
  original `.git/config`-credential class of defect, not merely the tarball-content
  guard above. The commit message is `chore: release v<version> [skip ci]`.
- **Creates a GitHub Release** (beta and stable channels) tagged `v<version>`.

This repo's `publish.yml` wrapper (`.github/workflows/publish.yml`) matches all of the
above: it passes `version-type`, `custom-version`, and `cascade-source` straight
through and does not add or override any step.

## Security audit (`.github/workflows/security-audit.yml`)

Daily at 08:00 UTC plus manual dispatch. Delegates to
`abofs/stonyx-workflows/.github/workflows/security-audit.yml@main`, which checks out
with `persist-credentials: false`, `pnpm install --frozen-lockfile`, then `pnpm audit
--audit-level moderate` with `continue-on-error: true` (so a finding is reported, not
blocking). Matches this repo's wrapper exactly; no local override to verify beyond that.

## What this doc cannot verify

Branch protection rules, the `CASCADE_PAT`/`NPM_TOKEN`/OIDC trust configuration, and any
AWS or other infrastructure the pipeline may depend on are out of scope for this
document (infrastructure/secrets configuration, not release *process*) and were not
inspected.

## Remediation of already-published versions — discrepancy check

`docs/deprecation-remediation.md` describes a **separate, out-of-band** corrective
action against already-published npm registry metadata (correcting the deprecation
message on 22 versions that shipped `package/.git/config`) — issue
[abofs/stonyx-cron#50](https://github.com/abofs/stonyx-cron/issues/50). That document's
own status block states, as of 2026-09-04: **NOT YET APPLIED** — `--check` exits 1,
because applying it requires an npm account with publish rights on the `@stonyx` scope
that does not currently exist in this org as a credential anyone holds (publishing
itself goes through per-job OIDC trusted publishing, not a standing credential, so
there is nothing to hand an operator). Nothing observed while writing this document
changes that status — it is a registry-metadata operation outside this repo's CI, and
no workflow run evidence of it having been applied was found.

That document draws an explicit scope boundary: it is remediation of **already
published** artifacts, and is deliberately separate from **preventing future
publishes** from including `.git/`, which it tracks as a distinct, separately gated
item: [abofs/stonyx-workflows#39](https://github.com/abofs/stonyx-workflows/issues/39).

**That preventive side is no longer open.** Reading the current reusable
`npm-publish.yml`, the "Pack and guard the release artifact" step described above —
which packs to a single tarball and refuses to publish one containing any
`^package/(.*/)?\.git(/|$)` entry — exists in the workflow this repo's `publish.yml`
actually calls today, with inline commentary citing `abofs/stonyx-workflows#39` as its
origin. Checkout steps across `ci.yml`, `npm-publish.yml`, and `security-audit.yml` all
now set `persist-credentials: false`, and the publish job's own git push authenticates
via a per-command `GIT_CONFIG_*` credential rather than a file on disk — both cited
inline as fixes for `abofs/stonyx-workflows#35`, the credential-in-`.git/config` root
cause the original 21 credential-bearing tarballs exploited. So: **the control that
stops this from recurring is live in the current pipeline; the cleanup of the 22
already-published versions' metadata is the piece still outstanding**, exactly as
`deprecation-remediation.md` states. This is a currency check against the live
workflow source, not a re-run of the remediation script — this document does not hold
`@stonyx` npm publish credentials and did not attempt `--apply` or `--check`.
