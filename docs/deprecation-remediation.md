# Deprecation Remediation — published `.git/config` versions

Tracking issue: [abofs/stonyx-cron#50](https://github.com/abofs/stonyx-cron/issues/50)

## The defect

22 published versions of `@stonyx/cron` shipped a `package/.git/config` file inside
the npm tarball. All 22 were already deprecated, with this text:

> This version inadvertently included .git/config with exposed credentials. Please upgrade to the latest version.

That message is self-defeating. The `latest` dist-tag points at `0.2.0`, and `0.2.0`
is itself one of the 22 affected versions. A user who obeys the notice installs the
deprecated artifact again and sees the same warning. It is a closed loop.

The severity is the loop, not credential exposure. Measured across all 22 affected
tarballs, the `extraheader` count is 0 — the shipped `.git/config` is a workstation
config (SSH remote, local branch names, editor metadata), not a CI checkout config.
No credential is published.

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

Verified 2026-09-04 by downloading all 142 published `@stonyx/cron` tarballs from
`dist.tarball` and running `tar tzf | grep -c '^package/\.git/'` against each.
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

**This requires an npm token with publish rights on the `@stonyx` scope.** It is a
registry metadata operation; there is no code change and nothing to release.

```sh
npm whoami                                  # must succeed
./scripts/deprecation-remediation.sh --apply
./scripts/deprecation-remediation.sh --check
```

`npm deprecate` is idempotent for identical text, so `--apply` is safe to re-run.

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
