# SME Template: Architect — stonyx-cron

> **Inherits from:** `beatrix-shared/docs/framework/templates/agents/architect.md`
> Load the base template first, then layer this project-specific context on top.

## Project Context

**Repo:** `abofs/stonyx-cron`
**Framework:** Stonyx module (`@stonyx/cron`) — job scheduling for the Stonyx framework
**Domain:** Advanced cron/job scheduling with min-heap priority queue, three schedule types (at/every/cron), async locking, error backoff, run history, and pluggable job execution

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (compiled to ESM) |
| Runtime | Node.js |
| Framework | Stonyx (runtime dependency) — config, logging |
| Scheduling | Custom 5-field cron parser with timezone support, interval scheduling, one-shot timestamps |
| Data Structure | Custom min-heap for O(1) next-job lookup |
| Build | tsc with dual tsconfig (src + test) |
| Test | QUnit + Sinon |
| Package Manager | pnpm |

## Architecture Patterns

- **CronService as the main API:** Not a singleton — consumers instantiate `new CronService()` and manage its lifecycle via `start()` / `stop()`
- **Min-heap for efficient scheduling:** Jobs are stored in a `MinHeap<HeapEntry>` keyed by `nextTrigger` timestamp — `peek()` always returns the soonest due job in O(1), avoiding full-scan on every timer tick
- **Three schedule kinds:** `at` (one-shot ISO-8601 or epoch), `every` (recurring interval in ms with optional anchor), `cron` (5-field expression with optional timezone) — each has its own `computeNextRunAtMs` branch
- **Async locking:** All state mutations (`add`, `update`, `remove`, timer processing) are serialized through `locked()` to prevent race conditions from concurrent async operations
- **Pluggable execution via `onJobDue` callback:** CronService does not define what a job does — consumers set `service.onJobDue = async (job) => { ... }` to handle execution, keeping the scheduler decoupled from business logic
- **Error backoff table:** Consecutive failures trigger escalating delays: 30s, 60s, 5m, 15m, 1h — the backoff is applied as `Math.max(normalNext, nowMs + backoff)` so it never shortens the interval
- **One-shot auto-delete:** Jobs with `deleteAfterRun: true` (default for `at` schedule kind) are removed from the service after successful execution
- **Auto-disable on schedule errors:** Three consecutive `computeNextRunAtMs` failures disable the job, preventing infinite retry loops on malformed schedules
- **RunLog for history:** Each execution is recorded with jobId, status, error, summary, runAtMs, durationMs, and nextRunAtMs — the log is per-job with configurable depth
- **Input normalization:** `normalizeJobInput` and `recoverFlatParams` handle AI-generated inputs that may have flat parameter structures or variant field names
- **Timer capping:** `MAX_TIMER_DELAY_MS` is 60 seconds — even if the next job is hours away, the timer re-arms at most every 60s to handle newly added jobs and clock drift
- **Rich subpath exports:** The package exports `./service`, `./cron-parser`, `./schedule`, `./job`, `./normalize`, `./locked`, `./run-log`, and `./min-heap` as independent entry points

## Live Knowledge

- The `stonyx-module` keyword means Stonyx loads this synchronously — `CronService.start()` must be called explicitly by the consumer, not by the framework lifecycle
- `removeFromHeap` rebuilds the heap by popping all items and re-pushing non-matching ones — this is O(n log n) but acceptable for typical job counts under 1000
- The `running` flag prevents re-entrant timer execution — if `onTimer` is already processing, the next tick just re-arms at `MAX_TIMER_DELAY_MS` and returns
- The cron parser is fully custom with zero dependencies — it supports wildcards, ranges, steps, lists, and month/day name aliases; timezone support uses `Intl.DateTimeFormat` for locale-aware field matching
- `Job.sessionTarget` and `Job.wakeMode` are scheduling metadata consumed by Beatrix — the cron service itself does not interpret them
- `computeNextRunAtMs` for `every` schedules uses an anchor-based calculation to prevent drift: `anchor + ceil((now - anchor) / interval) * interval`
