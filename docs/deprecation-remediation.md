# Deprecation Remediation — published `.git/config` versions

Tracking issue: [abofs/stonyx-cron#50](https://github.com/abofs/stonyx-cron/issues/50)

> **Status: NOT YET APPLIED as of 2026-09-04.** All 22 affected versions still carry the
> original self-defeating text. `--check` exits 1. Applying requires an npm account with
> publish rights on the `@stonyx` scope; no such credential exists in this org today.
> Update this block — do not delete it — when `--apply` has been run and `--check` prints
> `ALL CHECKS PASS`.

## The defect

22 published versions of `@stonyx/cron` shipped a `package/.git/config` file inside
the npm tarball. All 22 were already deprecated, with this text:

> This version inadvertently included .git/config with exposed credentials. Please upgrade to the latest version.

That message is self-defeating. The `latest` dist-tag points at `0.2.0`, and `0.2.0`
is itself one of the 22 affected versions. A user who obeys the notice installs the
deprecated artifact again and sees the same warning. It is a closed loop.

## Credential exposure — the affected set splits in two

An earlier revision of this document claimed the `extraheader` count was 0 across all 22
tarballs and that no credential was published. **That is true of `0.2.0` only, and false
of the other 21.** Re-measured 2026-09-04 by downloading each tarball from `dist.tarball`,
extracting it, and grepping the shipped `package/.git/config`:

```
0.2.0:          extraheader=0   remote=git@github.com:...      (packed from a workstation)
0.2.1-alpha.0:  extraheader=1   remote=https://github.com/...  (packed from a CI checkout)
0.2.1-beta.0:   extraheader=1   remote=https://github.com/...
0.2.1-beta.4:   extraheader=1   remote=https://github.com/...
0.2.1-beta.12:  extraheader=1   remote=https://github.com/...
0.2.1-beta.19:  extraheader=1   remote=https://github.com/...
```

The `git@` vs `https://` remote is the tell. `0.2.0` was packed from a workstation clone;
every `0.2.1-*` was packed from a CI checkout that had written an `http.extraheader`
credential into `.git/config`.

**Set 1 — `0.2.0` — metadata only.** SSH remote, local/private branch names, editor
metadata. No credential. For this version the severity really is the loop, not exposure.

**Set 2 — `0.2.1-alpha.0` and `0.2.1-beta.0` through `0.2.1-beta.19` (21 versions) —
credential-bearing.** Each shipped an `http.extraheader` line carrying a real GitHub
token. Across a sweep of all 1,389 published tarballs in the ten `abofs` packages, these
21 are the only credential-bearing artifacts found. **Four distinct tokens:** three
ephemeral `ghs_` GitHub Actions tokens and one shared `ghp_` classic PAT. For this set the
severity is a real, if now closed, credential leak *in addition to* the loop.

Token attribution, measured per tarball 2026-09-04:

```
ghs_ (3 distinct ephemeral GitHub Actions tokens, one each):
  0.2.1-alpha.0   0.2.1-beta.0   0.2.1-beta.4

ghp_ (1 shared classic PAT, 18 versions):
  0.2.1-beta.1   0.2.1-beta.2   0.2.1-beta.3
  0.2.1-beta.5  through  0.2.1-beta.19
```

An earlier revision of this document placed the three `ghs_` tokens on "the earliest three
publishes" and read a workflow swap off the default `GITHUB_TOKEN` out of that ordering.
**Both are wrong.** The split is not chronological: `beta.1` through `beta.3` carry the
shared PAT while `beta.4`, published after them, carries an ephemeral token. The two
credential types interleave, so the data does not support a clean swap date and no such
date is claimed here. The counts themselves — three distinct `ghs_`, one `ghp_` shared
across 18 — are unchanged and were re-measured.

### Was rotation required? Yes — and it is already done.

**All four leaked tokens were tested against the GitHub API on 2026-09-04 and all four
return HTTP 401 / Bad credentials. Every one is revoked.** There is no live exposure and
no incident to open. This is recorded here explicitly so a future reader can answer the
"was rotation ever required, and was it done" question from this file rather than having
to re-derive it.

Blast radius is bounded to the config file itself: only `package/.git/config` was ever
included. No `objects/`, no `packed-refs`, no `logs/` — so no repository history or
unpublished source left with these tarballs.

### Why this does not change the remediation

The replacement text below — *"shipped package/.git/config in the published tarball and
must not be used"* — is accurate for both sets and is deliberately unchanged. Both sets
warrant the same instruction: do not use these versions, install from the maintained beta
channel. The split changes the *rationale recorded here*, not the action.

### Divergence from the sibling package

`@stonyx/events@0.1.0` measures `extraheader=0` with a `git@` remote, so the
metadata-only framing in
[stonyx-events/docs/deprecation-remediation.md](https://github.com/abofs/stonyx-events/blob/dev/docs/deprecation-remediation.md)
is correct for that package and is intentionally **not** mirrored from this section. The
two documents share wording where the facts are shared and diverge where they are not;
they are kept accurate rather than identical.

## The decision

Per the CTO decision on issue #50: **correct the deprecation text only. Do not
advance the `latest` dist-tag.**

`latest` is vestigial in this org — consumers track the beta line via
`pnpm.overrides` — there is no maintained stable line to advance to, and moving it
would change what unpinned installs receive for the first time in this package's
history. That is a larger behavioural change than the one being fixed.

Advancing `latest` is deferred to a gated follow-up, gated on the re-land decision
for #34 and #36. Nothing in this remediation touches any dist-tag.

## Scope boundary

This is remediation of **already-published** artifacts. Preventing future publishes
from including `.git/` is a separate control tracked in
[abofs/stonyx-workflows#39](https://github.com/abofs/stonyx-workflows/issues/39).
Neither blocks the other.

Unpublishing is not available — npm does not permit it past 72 hours. These
versions are permanent; only their metadata can change.

## Affected versions

Verified 2026-09-04 by downloading all 142 `@stonyx/cron` tarballs published as of that
measurement from `dist.tarball` and running `tar tzf | grep -c '^package/\.git/'` against each.
Exactly 22 returned a non-zero count. The other 120 returned 0.

That set is exactly equal to the set already carrying a `deprecated` field — no
affected version is missing a deprecation, and no clean version has one.

```
0.2.0
0.2.1-alpha.0
0.2.1-beta.0   0.2.1-beta.1   0.2.1-beta.2   0.2.1-beta.3   0.2.1-beta.4
0.2.1-beta.5   0.2.1-beta.6   0.2.1-beta.7   0.2.1-beta.8   0.2.1-beta.9
0.2.1-beta.10  0.2.1-beta.11  0.2.1-beta.12  0.2.1-beta.13  0.2.1-beta.14
0.2.1-beta.15  0.2.1-beta.16  0.2.1-beta.17  0.2.1-beta.18  0.2.1-beta.19
```

The sibling package `@stonyx/events` has exactly one affected version, `0.1.0`.
See [abofs/stonyx-events#23](https://github.com/abofs/stonyx-events/issues/23).

## Replacement text

```
This version shipped package/.git/config in the published tarball and must not be used. The `latest` tag is NOT a safe upgrade target - it also points at an affected version. Install from the maintained beta channel instead: npm install @stonyx/cron@beta (resolves to 0.2.1-beta.95 as of 2026-09-03).
```

The message names the **channel**, not a frozen version string. A frozen string
goes stale on the next beta bump and would need re-applying across 22 versions
forever; a channel pointer describes where the maintained line already is. It stays
falsifiable — resolve the tag at check time and assert the resolution is not in the
affected set — and it cannot regress into an affected version, since every affected
version is `<= 0.2.1-beta.19` and `beta` only advances.

The parenthetical resolution is descriptive of a point in time, not an endorsement
of `beta.95`'s content. It is what makes the message auditable.

## Applying it

**This requires an npm account with publish rights on the `@stonyx` scope, authenticated
interactively with `npm login`. It is not a token, and there is no token to go looking
for.** It is a registry metadata operation; there is no code change and nothing to
release.

### There is no npm publish token in this org

Publishing authenticates via **GitHub OIDC trusted publishing**
(`stonyx-workflows/docs/release.md:51,57`). The identity is minted per CI job, bound to a
specific repository and package, and lives only for the duration of that job. It does not
exist outside a workflow run and cannot be handed to an operator.

`CASCADE_PAT` — the one secret the publish workflow declares — is a **GitHub** PAT used
for cascade dispatch. It grants nothing on the `@stonyx` npm scope and is irrelevant here.

An earlier revision of this runbook asserted the credential was an org-level GitHub
secret, supported by `gh secret list --org abofs` returning HTTP 403. That 403 proves only
that org-secret *enumeration* failed; it was converted into a positive claim about what
one of those secrets is, and the workflow source falsifies it. Following the old runbook
would have sent an operator hunting for a secret that does not exist.

Do **not** mint a standing org-wide npm token to work around this. That escalation shape
is what [abofs/stonyx-workflows#35](https://github.com/abofs/stonyx-workflows/issues/35)
exists to prevent.

### Who to ask

All 22 affected versions here — and `@stonyx/events@0.1.0` — are **already deprecated**.
That means `npm deprecate` was successfully run against this scope at some point, by
someone. Whoever did that holds exactly the access this script needs. That turns a vague
"find someone with credentials" into a specific, answerable question, and it is the
fastest route to an executor.

```sh
./scripts/deprecation-remediation.sh --check   # read-only; run this FIRST
npm login --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org   # must succeed
./scripts/deprecation-remediation.sh --apply
./scripts/deprecation-remediation.sh --check   # must print ALL CHECKS PASS
```

`npm deprecate` is idempotent for identical text, so `--apply` is safe to re-run.

### If `--apply` aborts partway through

`do_apply` runs under `set -e` and writes to the registry version-by-version — 22
separate `npm deprecate` calls, each of which prompts for a one-time password. If any one
of them fails (mistyped OTP, expired session, network drop, `Ctrl-C`) the script exits
immediately, and the versions it had already reached keep the corrected text while the
rest still carry the original. That mixed state is what a partial apply looks like:
`--check` exits 1 and reports the unreached versions as `still says 'the latest version'`
while the reached ones pass.

Recovery is simply to re-run `--apply` from the top. `npm deprecate` is idempotent for
identical text, so re-processing the versions that already converged is a no-op and there
is no need to work out where it stopped — do not try to resume from a partial list. Then
re-run `--check`: it compares every version's message against the exact replacement text,
so a green `--check` is the confirmation that all 22 have converged on one string.

### Rolling back

**Do not run `npm deprecate <pkg>@<version> ""`.** The empty-string form does not restore
the previous message — it *un-deprecates* the version, deleting the `deprecated` field
outright. Run against this set it would strip the warning from all 22 versions, including
the 21 that shipped a real leaked credential (`0.2.1-alpha.0` and `0.2.1-beta.0` through
`beta.19`), leaving them installable with no notice at all. That is strictly worse than
either the original text or the corrected one, and it is the first thing an operator
reaching for an undo will find in the `npm deprecate` docs.

The correct rollback is to **re-apply the original deprecation string**. That string is
quoted verbatim under [The defect](#the-defect) above; for `@stonyx/cron` the rollback
value is:

```
This version inadvertently included .git/config with exposed credentials. Please upgrade to the latest version.
```

Apply it exactly the way `--apply` applies the corrected text — version-by-version across
the same 22-version list, never as a semver range, for the reason in
[Why the script iterates instead of using a range](#why-the-script-iterates-instead-of-using-a-range).
Afterwards `--check` is *expected* to exit 1, reporting all 22 as `still says 'the latest
version'`; that is the pre-remediation red state restored, not a failed rollback.

Rolling back reinstates the closed loop this remediation exists to fix, so it is a last
resort rather than a routine undo. The change is registry metadata only and is reversible
in both directions — there is nothing lost by leaving the corrected text in place while a
concern is investigated.

### Why the script iterates instead of using a range

`npm deprecate` takes a semver **range**, and this affected set is not expressible
as a clean one — it is `0.2.0`, `0.2.1-alpha.0`, and `0.2.1-beta.0` through
`beta.19`. A naive `@stonyx/cron@"<0.2.1-beta.20"` would also sweep `0.0.1` through
`0.1.0`, which are clean and currently undeprecated. The script applies
version-by-version from the explicit list, and its `--check` mode asserts the
deprecated count is still exactly 22 afterwards to catch exactly this going wrong.

## Verification

`--check` is read-only and needs no credentials. It runs a control first: it packs
`@stonyx/cron@0.2.0` and asserts at least one `package/.git/` entry. If that control
returns 0 the scan is inert and every result below it is void, so the script aborts
rather than reporting a false pass.

Run against the registry on 2026-09-04, before the rewrite, `--check` exits 1 and
reports all 22 versions still carrying `the latest version`, with the control live
and the clean-target, dist-tag and collateral checks green. That is the expected red
state; it goes green once `--apply` has been run.

### Evidence recorded for the acceptance criteria

Fresh packs from the registry, with controls, 2026-09-04:

```
@stonyx/cron@0.2.1-beta.95    -> package/.git/ entries: 0
@stonyx/cron@0.2.0            -> package/.git/ entries: 1     (control: check is live)
@stonyx/events@0.1.1-beta.52  -> package/.git/ entries: 0
@stonyx/events@0.1.0          -> package/.git/ entries: 1     (control: check is live)
```

The named target boots. `@stonyx/cron` requires Stonyx to be initialized before the
export is touched, so a bare `require` is not acceptable evidence — measured, it
throws `Stonyx has not been initialized yet`. The harness initializes first:

```js
import { pathToFileURL } from 'url';

const cwd = process.cwd();
const { default: Stonyx } = await import('stonyx');
const { default: config } = await import(pathToFileURL(`${cwd}/config/environment.js`).href);

new Stonyx(config, cwd);
await Stonyx.ready;

const cron = await import('@stonyx/cron');
const service = await import('@stonyx/cron/service');
```

Result of a clean-directory `npm install @stonyx/cron@beta` (resolved
`0.2.1-beta.95`, pulling `stonyx@0.2.3-beta.81`) followed by that harness:

```
stonyx initialized: true
@stonyx/cron loaded. exports: default
@stonyx/cron/service loaded. exports: default
BOOT OK
```

The negative control — importing `@stonyx/cron` without initializing Stonyx — throws
`Stonyx has not been initialized yet`, confirming the harness exercises something a
bare require does not.
