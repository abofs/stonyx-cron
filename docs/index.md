# @stonyx/cron Architecture

## Overview

`@stonyx/cron` is the Stonyx framework module for scheduled task execution. It ships
**two independent schedulers** behind one package, and the rest of this document, and
the two area pages it links to, treat them as two distinct areas rather than variations
on each other — they share no runtime state and agree on exactly one guarantee (a job
never runs concurrently with itself).

## Areas

### `Cron` — the fire-and-forget interval registry

The default export (`src/main.ts`) is a singleton that registers a callback against a
plain seconds-based interval and drives it off a single `setTimeout`, using a min-heap
(`src/min-heap.ts`) keyed on next-trigger time so the scheduler always knows the next
job to run in O(log n) without scanning every registered job. It reschedules a job
*before* invoking its callback and never awaits the result — different jobs due on the
same tick may overlap, but a per-job in-flight guard (`job.runningAtMs`) skips a job
whose previous invocation has not yet settled, and keeps skipping it, forever, with one
ungated warning per stuck run. There is no timeout and no persistence; `Cron` is
intentionally minimal. See [Area: Cron](areas/cron.md) for the full mechanism —
including the `MinHeap` internals, the error-handling rules that keep a callback
failure from ever reaching the scheduler, and the known limitation around
re-registering a live key.

### `CronService` — CRUD, run log, backoff, and locked three-phase execution

`src/service.ts`, published separately as `@stonyx/cron/service`, is a heavier,
non-singleton class consumers instantiate and drive with `start()`/`stop()`. It adds
CRUD over jobs with three schedule kinds (`at`, `every`, `cron` — the last via a
dependency-free parser in `src/cron-parser.ts`), a per-job run log, and error backoff
that pushes a failing job's next run out on an escalating schedule. Execution runs
through a lock-guarded three-phase model — claim, invoke (unlocked), settle — so an
arbitrarily slow or hung consumer callback can never wedge `add`/`update`/`remove`,
though it can still strand its own job and, on the timer path, stall every later job in
that tick's batch. See [Area: CronService](areas/cron-service.md) for the claim/settle
mechanics, the two independent claim paths (`run()` vs. the timer's batch claim), and
the residual hang behaviour that is tracked but not fixed.

## Build, Run, Test

Verified against this repo's `package.json` scripts and a clean `pnpm install
--frozen-lockfile && pnpm test` run (200/200 passing, no lockfile changes):

```bash
pnpm install --frozen-lockfile   # installs; falls back to `pnpm install` if the lockfile is stale
pnpm build                       # tsc -> dist/
pnpm test                        # pnpm build && NODE_ENV=test node --import tsx/esm --import ./test/setup.ts \
                                  #   node_modules/qunit/bin/qunit.js 'test/**/*-test.ts'
```

`pnpm test` runs `pnpm build` first and then runs the `.ts` test sources directly under
`tsx` (nothing is precompiled to a `dist-test/`). The build step is load-bearing, not
incidental: test code that imports `@stonyx/cron` resolves that self-reference to
`dist/main.js`, so a test run without the build step would exercise a stale or absent
build artifact instead of current `src/`. `build:test` (`tsc -p tsconfig.test.json`) is
a separate type-check-only script for `src`+`test`+`config`; it is **not** a
prerequisite of `pnpm test` and is not invoked by it.

**Fake-timer rules for the scheduler tests** (both schedulers), from `docs/testing.md`,
restated here because getting these wrong makes a test pass vacuously:

- Drive the scheduler through the fake clock (`sinon.useFakeTimers({ shouldAdvanceTime:
  false })`, then `clock.tick(...)` / `await clock.tickAsync(...)`) — never by calling
  `onTimer()` directly, which makes `findDueJobs` return `[]` and the test pass without
  exercising anything.
- Give `onJobDue`/callbacks a handler that really yields (a hand-resolved deferred, or a
  never-settling promise for hang probes); a synchronous handler never enters the
  lock's critical section.
- Never `await` a possibly-hung path from the test body; float the promise and assert a
  settled flag after `clock.tickAsync(0)`.
- Call `resetLock()` (`@stonyx/cron/locked`) in `afterEach` — the lock is module-global
  and one poisoned chain cascades into later tests.
- Scope heap assertions to a key (`heap.items.filter(i => i.key === job.id).length`),
  never bare `items.length`.

Full detail, including spy/stub patterns and the `test/config/environment.js` override
that sets `cron.log: false` for the suite, is in [Testing](testing.md).

## Delivery

`@stonyx/cron` is published to npm and consumed as a library inside a Node.js backend
that already runs the Stonyx framework (it requires `Stonyx.ready` before either export
is touched). It has no web, iOS, or Android surface of its own — delivery is "install
the package into a Node service," not an app deployment.

## Dependencies

- **`stonyx` (dependency, `0.2.3-beta.107`)** — the base Stonyx framework: a
  plug-and-play module system with async module loading/initialization, centralized
  color-coded logging, configuration, a CLI (`stonyx serve`/`stonyx test`/...), and
  lifecycle hooks. `@stonyx/cron` imports `stonyx/config` and `stonyx/log` from it and
  requires `Stonyx.ready` before its own exports are usable.
- **`@stonyx/utils` (devDependency, `0.2.3-beta.29`)** — a utilities module providing
  helpers for files, objects, strings, dates, promises, and interactive CLI prompts.
  `@stonyx/cron` uses only `getTimestamp()` from `@stonyx/utils/date` (Unix seconds, not
  milliseconds — the one time source every internal computation is required to use).

## Guides

- [Area: Cron](areas/cron.md) — the fire-and-forget interval registry
- [Area: CronService](areas/cron-service.md) — CRUD, run log, backoff, locked execution
- [Architecture](architecture.md) — `Cron`/`MinHeap` class internals, private-member
  conventions, error-handling rules, configuration reference
- [CronService Design](service-design.md) — locking, the three-phase execution model,
  claims and `inFlight`
- [Extension Guide](extension-guide.md) — guidance for common feature additions
- [Project Structure](project-structure.md) — source layout and component overview
- [Testing](testing.md) — running tests, layout, fake timers, rules for testing the
  scheduler
- [Release](release.md) — release process
- [Deprecation Remediation](deprecation-remediation.md) — corrective deprecation text
  for the published versions that shipped `.git/config`
