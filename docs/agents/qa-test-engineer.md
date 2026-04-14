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
| Build | tsc with separate `tsconfig.test.json` |
| Test Runner | `stonyx test` CLI |
| CI | GitHub Actions (`ci.yml`) |

## Architecture Patterns

- **Test build pipeline:** Tests compile to `dist-test/` via `tsconfig.test.json`, then run with `stonyx test 'dist-test/test/**/*-test.js'`
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
