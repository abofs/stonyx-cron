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
- **Async locking, but never around the consumer callback:** All state mutations (`add`, `update`, `remove`, and the claim/settle phases of job execution) are serialized through `locked()` to prevent race conditions from concurrent async operations. `onJobDue` is deliberately awaited OUTSIDE the lock — see the phase split below
- **Pluggable execution via `onJobDue` callback:** CronService does not define what a job does — consumers set `service.onJobDue = async (job) => { ... }` to handle execution, keeping the scheduler decoupled from business logic
- **Three-phase job execution (#34):** `executeJob` is split into claim (locked — `markRunning` + detach from heap), invoke (UNLOCKED — `await onJobDue`), and settle (locked — `applyResult`, run-log, delete-after-run, heap re-insert). Arbitrary consumer code is never awaited while a lock is held, so a callback that never settles cannot wedge the lock chain. Nothing wraps the invoke in `locked()` — doing so would recreate the wedge through a second door
- **Two claim implementations, not one (#34):** the two entry points do NOT share a code path. `run()` → `executeJob` → `locked(#claimJob)` → `#executeClaimed`; `onTimer` never calls `executeJob` at all — it claims the **entire due batch under one lock turn** (`findDueJobs` pops every due entry, `markRunning` flags each) and then enters at `#executeClaimed` per job. Per-job `locked()` calls would let a concurrent `run()` claim a job the batch had already detached, so the batch claim is deliberate. Two consequences a reviewer of the next change here needs: a job can be marked running and off the heap well before its own callback starts, while earlier siblings are still in flight; and the per-job `catch` in the batch loop therefore cannot rethrow, because that would abandon every sibling's claim. The two claims also guard differently — `#claimJob` checks `job.state.runningAtMs` explicitly, the batch path relies entirely on `isDue`'s `!job.state.runningAtMs` clause. That clause is load-bearing, not an optimisation
- **One in-flight invocation per job, three skip reasons (#34):** the claim bounds a job to one live invocation on every path. `run()` returns `{ status: 'skipped', reason: 'already running' }` rather than invoking a second time, `'not due'` when `mode` is `'due'` and the time has not arrived, and `'removed'` when the job was removed between the unlocked lookup and the claim. `'removed'` is new with the phase split and exists *because of* it: before #34 `remove()` deadlocked behind a hung callback, so removed-while-claimed was unreachable. It is guarded in three places — `#claimJob`'s membership check, `#executeClaimed`'s re-check (which also hand-releases the claim, since that early return is the one path that skips settle), and `#settleJob`'s identity guard. All three compare **identity, not id**: a replacement registered under the same id must not be unscheduled by the original's settle
- **Unbounded cross-job fan-out is the accepted cost (#34):** taking the callback out of the critical section removed the only thing that serialized execution across DIFFERENT jobs. N concurrent `run()` calls on N distinct jobs now produce N concurrent callbacks; nothing caps it — not `locked()`, not `this.running` (which gates only the timer path), not `runningAtMs` (which is per-job). The scheduler never generates this on its own; only a caller can. Restoring the bound would restore the deadlock, so the bound belongs at a higher layer
- **Scheduler death is NOT fixed by the phase split (#34, residual):** the split fixes the *lock* wedge — a hung callback no longer blocks `add`/`update`/`remove`. It does not fix the *timer*. `onTimer` awaits `#executeClaimed` in a sequential `for` loop with `this.running === true`, and `running` is cleared only in the `finally`. One callback that never settles therefore stops the loop forever: `running` stays true, every subsequent `onTimer` early-returns and re-arms, no job ever executes again, and its batch siblings stay claimed and off-heap having never been invoked. CRUD still resolves and `status()` still reports `started: true`, so the failure is now **silent** where it used to be loud. Bounding the callback (an execution timeout plus batch-sibling release) is tracked separately — do not read #34 as "the hang is fixed"
- **Error backoff table:** Consecutive failures trigger escalating delays: 30s, 60s, 5m, 15m, 1h — the backoff is applied as `Math.max(normalNext, nowMs + backoff)` so it never shortens the interval
- **One-shot auto-delete:** Jobs with `deleteAfterRun: true` (default for `at` schedule kind) are removed from the service after successful execution
- **Auto-disable on schedule errors:** Three consecutive `computeNextRunAtMs` failures disable the job, preventing infinite retry loops on malformed schedules
- **RunLog for history:** Each execution is recorded with jobId, status, error, summary, runAtMs, durationMs, and nextRunAtMs — the log is per-job with configurable depth
- **Input normalization:** `normalizeJobInput` and `recoverFlatParams` handle AI-generated inputs that may have flat parameter structures or variant field names
- **Timer capping:** `MAX_TIMER_DELAY_MS` is 60 seconds — even if the next job is hours away, the timer re-arms at most every 60s to handle newly added jobs and clock drift
- **Rich subpath exports:** The package exports `./service`, `./cron-parser`, `./schedule`, `./job`, `./normalize`, `./locked`, `./run-log`, and `./min-heap` as independent entry points
- **Two schedulers, not one.** Besides `CronService`, the package's default export is the legacy `Cron` singleton in `src/main.ts` (`register` / `unregister` / `runDueJobs`). It has its own execution contract: fire-and-forget (the callback is never awaited), reschedule-before-invoke, and a per-job in-flight guard (`job.runningAtMs`) that **skips** a due job whose previous invocation has not settled. Unlike `CronService.run()` it returns `void`, so the skip is invisible to the caller — which is why the wedged-job warning is reported ungated, on `log.warn`, once per stuck run. It has no timeout: a callback that never settles disables that one job permanently. See `docs/architecture.md` § Error Handling.

## Live Knowledge

- The `stonyx-module` keyword means Stonyx loads this synchronously — `CronService.start()` must be called explicitly by the consumer, not by the framework lifecycle
- `removeFromHeap` rebuilds the heap by popping all items and re-pushing non-matching ones — this is O(n log n) but acceptable for typical job counts under 1000
- The `running` flag prevents re-entrant timer execution — if `onTimer` is already processing, the next tick just re-arms at `MAX_TIMER_DELAY_MS` and returns
- The cron parser is fully custom with zero dependencies — it supports wildcards, ranges, steps, lists, and month/day name aliases; timezone support uses `Intl.DateTimeFormat` for locale-aware field matching
- `Job.sessionTarget` and `Job.wakeMode` are scheduling metadata consumed by Beatrix — the cron service itself does not interpret them
- `computeNextRunAtMs` for `every` schedules uses an anchor-based calculation to prevent drift: `anchor + ceil((now - anchor) / interval) * interval`
