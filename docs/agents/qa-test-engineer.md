# SME Template: QA Test Engineer — stonyx-cron

> **Inherits from:** `beatrix-shared/docs/framework/templates/agents/qa-test-engineer.md`
> Load the base template first, then layer this project-specific context on top.

## Project Context

**Repo:** `abofs/stonyx-cron`
**Framework:** Stonyx module (`@stonyx/cron`) — job scheduling for the Stonyx framework
**Domain:** Advanced cron/job scheduling with min-heap priority queue, three schedule types (at/every/cron), async locking, error backoff, run history, and pluggable execution

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (compiled to ESM) |
| Test Framework | QUnit |
| Mocking | Sinon (especially fake timers for timer-based tests) |
| Build | `tsc` -> `dist/` (`pnpm build`, run as a prerequisite of `pnpm test`) |
| Test Runner | QUnit, invoked directly on the TypeScript sources via `tsx/esm` |
| CI | GitHub Actions (`ci.yml`) |

## Architecture Patterns

- **Test build pipeline:** `pnpm test` is `pnpm build && NODE_ENV=test node --import tsx/esm --import ./test/setup.ts node_modules/qunit/bin/qunit.js 'test/**/*-test.ts'`. Tests are **not** precompiled to `dist-test/` and are **not** run through a `stonyx test` CLI; QUnit runs the `.ts` sources directly under `tsx`. The `pnpm build` prefix matters: it builds `dist/`, and the package self-reference `@stonyx/cron` resolves to `dist/main.js`, so a test importing `@stonyx/cron` exercises the **built artifact** rather than `src/`. `test/unit/cron-test.ts` pins that with an `import.meta.resolve` assertion — the 2026-09-01 revert wave was invisible precisely because nothing asserted on `dist/`.
- **Integration tests available:** `test/integration/` tests the full CronService lifecycle — start, add jobs, timer fires, execute, re-schedule
- **Sample handler files:** `test/sample/` contains sample job definitions and configs
- **Fake timers essential:** Sinon fake timers are critical for testing `armTimer`, `onTimer`, and the heartbeat-like scheduling loop — real timers make tests slow and flaky
- **Pure function testability:** `computeNextRunAtMs`, `validateSchedule`, `parseCronExpression`, `parseField`, `nextOccurrence`, `errorBackoffMs`, `isDue`, `createJob`, and `normalizeJobInput` are all pure functions testable without any service setup
- **MinHeap tested independently:** The min-heap is exported as `@stonyx/cron/min-heap` and has its own focused test coverage — push, pop, peek, remove, ordering invariants

## Live Knowledge

- `CronService` is NOT a singleton — tests can create fresh instances without cleanup, unlike the singleton modules
- The `locked()` utility serializes async operations — tests that call `add()` / `update()` / `remove()` concurrently should verify that operations don't interleave
- Cron expression parsing must handle edge cases: month/day names (case-insensitive), day-of-week 7→0 normalization, wildcards with steps, and the OR semantics when both day-of-month and day-of-week are restricted
- `nextOccurrence` has a 4-year search limit — test that expressions with no valid future match within 4 years return `undefined`
- Error backoff values are `[30000, 60000, 300000, 900000, 3600000]` — test that `consecutiveErrors` beyond 5 caps at 3600000ms
- The `recoverFlatParams` normalizer handles AI-generated inputs with flat keys like `scheduleCron` instead of nested `schedule.kind: 'cron'` — test these recovery paths
- `applyResult` auto-disables `at`-kind jobs after any terminal status — test that both success and error disable them
- The timer re-arms even during `running` state to prevent scheduler death — test the re-entrancy guard by having `onJobDue` trigger another timer tick

## Test-Design Rules Earned the Hard Way (#34)

These are not preferences. Each one has a measured incident behind it.

- **Drive the scheduler through the clock, never by calling `onTimer()` directly.** A first draft of #34's AC3 called `onTimer()` without advancing the fake clock. `findDueJobs` returned `[]`, `onJobDue` was never called, nothing hung — and **the test passed against the unfixed code.** Always `await clock.tickAsync(...)` past `nextRunAtMs` so `armTimer` fires `onTimer` naturally, and carry an assertion proving a callback is genuinely in flight (`service.running === true`, or `job.state.runningAtMs` set) so a vacuous pass is impossible.
- **At least one test per execution-path change must drive `onJobDue` with a callback that genuinely yields.** The pre-#34 audit found that *every* execution test in this repo set `onJobDue` to a **synchronous** function. The lock's critical section was therefore never entered, `service.running` was never observed true, and a deadlock bug lived in the suite's blind spot for its whole life. Use a hand-resolved deferred (`new Promise(r => { resolve = r; })`), or a never-settling promise for hang probes.
- **The synchronous-stand-in trap generalises past `onJobDue`.** The same defect recurred inside the #34 fix itself: a test stubbed `log.error` with a **synchronous** `.throws()` and asserted no unhandled rejection escaped. `log.error` is an `async` chronicle method, so its real failures are rejections — the stub had the wrong shape and the assertion was incapable of failing. **When you stub something, match its sync/async shape to the real implementation, then mutate to prove the assertion can fail.**
- **Never await a possibly-hung path from the test body.** Float the promise and assert a settled-flag after `clock.tickAsync(0)`. A hung path then produces a clean assertion failure instead of a runner timeout you have to interpret.
- **Watch the measurement point, not just the assertion.** `findDueJobs` pops heap entries and silently discards any whose job is not due, so the scheduler self-heals a duplicate entry on the next timer pass. An assertion placed after a trailing `tickAsync` measures the healed state and passes against the broken code. Sample at settle time, or go through `run()` (which arms a timer but never fires one) and assert with no trailing tick.
- **Heap assertions are key-scoped** — `heap.items.filter(i => i.key === job.id).length`, never `items.length`.
- **`resetLock()` in `afterEach`.** The lock is module-global; a poisoned chain from one test cascades into every test after it.
- **Label honestly.** `precondition:` must mean "passes in the red run too" — that is the label a reviewer leans on to rule out the harness trap, so it cannot be attached to a property only the fix creates. `test/unit/service-phase-split-test.ts` uses `reached:` for post-fix non-vacuity checks and `guard:` for assertions that also pass pre-fix.
- **`config.cron.log` is `false` for the whole suite.** `test/config/environment.js` pins it and the override IS applied — stonyx's config loader imports the `${basePath}.js` specifier directly, which is why that file must stay `.js` (see `test/unit/publish-surface-test.ts` and #30). So `service.log()` is a no-op in tests: a test that expects to observe a gated log line must flip `config.cron.log` itself and restore it. A test that depends on the flag being *off* must pin it off itself rather than inherit it — another file's unrestored write is not a precondition.

