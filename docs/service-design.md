# CronService Design

How `CronService` (`src/service.ts`, published as `@stonyx/cron/service`) works inside. The consumer contract (the `run()` result table, the concurrency guarantee, the residual hang and the breaking changes in this line) is in [`README.md`](../README.md#cronservice). This page explains the mechanism behind it.

`CronService` is not the default export. The default export is the `Cron` singleton in `src/main.ts`; see [Two schedulers](#two-schedulers) below and [architecture.md](architecture.md).

## Shape

- **Not a singleton.** Consumers create `new CronService()` and manage its lifecycle with `start()` and `stop()`. The module carries the `stonyx-module` keyword, so Stonyx loads it synchronously and never calls `start()` for you.
- **Min-heap scheduling.** Jobs sit in a `MinHeap<HeapEntry>` keyed by `nextTrigger`, so `peek()` returns the soonest due job in O(1) and a timer tick does not scan every job. `removeFromHeap` rebuilds the heap (pop everything, re-push the rest), which is O(n log n); that is acceptable at typical job counts.
- **Three schedule kinds**, each with its own branch in `computeNextRunAtMs`:
  - `at`: one-shot, ISO-8601 or epoch ms.
  - `every`: recurring interval in ms with an optional `anchorMs`. The next run is `anchor + ceil((now - anchor) / everyMs) * everyMs`, so it does not drift.
  - `cron`: a 5-field expression with an optional timezone.
- **Custom cron parser** (`src/cron-parser.ts`), with no dependencies. It supports wildcards, ranges, steps, lists, and month/day names (case-insensitive), and it normalizes day-of-week `7` to `0`. When both day-of-month and day-of-week are restricted, matching either one satisfies the day (traditional cron OR semantics). Timezones go through `Intl.DateTimeFormat`. `nextOccurrence` searches up to 4 years ahead and returns `undefined` if nothing matches.
- **Pluggable execution.** `CronService` does not define what a job does. Consumers set `service.onJobDue = async (job) => { ... }`.
- **Timer capping.** `MAX_TIMER_DELAY_MS` is 60 seconds. Even when the next job is hours away, the timer re-arms at most 60 s out, which picks up newly added jobs and absorbs clock drift.
- **Opaque metadata.** `Job.sessionTarget` and `Job.wakeMode` are consumer-defined scheduling metadata. `normalizeJobInput` fills in defaults for them, but the service never interprets them.
- **Input normalization.** `normalizeJobInput` and `recoverFlatParams` (`src/normalize.ts`) accept loosely shaped input, for example flat top-level keys in place of a nested `schedule`. They recover the structure, coerce types and apply defaults.
- **IDs.** `Job.id` comes from `crypto.randomUUID()`. Names are not deduplicated, so two jobs with the same name are two jobs.

## Job outcomes

- **Error backoff.** Consecutive failures delay the next run by 30 s, 60 s, 5 min, 15 min, then 1 h, and it stays at 1 h after that (`ERROR_BACKOFF_MS` in `src/job.ts`). The delay is applied as `Math.max(normalNext, nowMs + backoff)`, so it never shortens the interval. A success resets the count.
- **One-shot jobs.** `at`-kind jobs are disabled after any terminal status, success or error. If `deleteAfterRun` is true (the default for `at`), the job is removed and no heap entry remains.
- **Auto-disable on schedule errors.** Three consecutive `computeNextRunAtMs` failures disable the job, so a malformed schedule cannot retry forever. Updating the schedule resets the counter.
- **Run log.** Every execution records jobId, status, error, summary, runAtMs, durationMs and nextRunAtMs, per job, at a configurable depth (`src/run-log.ts`).

## Locking and the three-phase execution

All state mutations (`add`, `update`, `remove`, and the claim and settle phases of execution) are serialized through `locked()` (`src/locked.ts`). The consumer callback is never awaited inside the lock.

`executeJob` runs in three phases:

1. **Claim** (locked): `markRunning`, then detach the job from the heap.
2. **Invoke** (not locked): `await onJobDue(job)`.
3. **Settle** (locked): `applyResult`, the run-log record, delete-after-run, and heap re-insert.

Because arbitrary consumer code never runs while the lock is held, a callback that never settles cannot wedge `add`, `update` or `remove`. Wrapping the invoke phase in `locked()` would bring that wedge back.

### Two claim paths

The two entry points do not share a claim:

- `run()` goes `executeJob` → `locked(#claimJob)` → `#executeClaimed`.
- `onTimer` never calls `executeJob`. It claims the **whole due batch in one lock turn** (`findDueJobs` pops every due entry and `markRunning` flags each one), then calls `#executeClaimed` per job. Per-job `locked()` calls would let a concurrent `run()` claim a job the batch has already detached.

What follows from that:

- A job can be marked running and off the heap well before its own callback starts, while earlier jobs in the batch are still in flight.
- The per-job `catch` in the batch loop cannot rethrow, because that would abandon every later job's claim.
- `#claimJob` checks `job.state.runningAtMs` explicitly. The batch path relies entirely on the `!job.state.runningAtMs` clause inside `isDue`, so that clause is load-bearing, not an optimization.
- Settle runs in a `finally`. A claim without a matching settle would leave a permanently dead job: off the heap, `runningAtMs` set, `isDue` false forever, and `run()` refusing forever. The per-job handler in `onTimer` reports on `log.error`, which no config flag gates.

### One in-flight invocation per job

The claim limits each job to one live invocation on every path. `run()` returns `{ status: 'skipped', reason }` instead of invoking twice:

- `'already running'`: a previous invocation of this job has not settled.
- `'not due'`: `mode` is `'due'` and the next run time has not arrived.
- `'removed'`: the job was removed between the unlocked lookup and the claim.

`'removed'` exists because of the phase split: before it, `remove()` deadlocked behind a hung callback, so a job could not be removed while claimed. It is checked in three places:

- the membership check in `#claimJob`;
- the re-check in `#executeClaimed`, which also releases the claim by hand, because that early return is the one path that skips settle;
- the identity guard in `#settleJob`.

All three compare **object identity, not id**, so a replacement registered under the same id is never unscheduled by the original job's settle.

### Cross-job fan-out

Taking the callback out of the lock also removed the only thing that serialized execution across *different* jobs. N concurrent `run()` calls on N distinct jobs produce N concurrent callbacks. Nothing caps that: `locked()` does not, `this.running` does not (it gates only the timer path), and `runningAtMs` does not (it is per job). The scheduler never generates this fan-out on its own; only a caller can. Restoring a cap inside the service would restore the deadlock, so a cap belongs in the caller.

### What the phase split does not fix: a hung callback stops the timer

The split fixes the lock wedge. It does not fix the timer. `onTimer` awaits `#executeClaimed` in a sequential `for` loop with `this.running === true`, and `running` is cleared only in the `finally`. One callback that never settles stops that loop permanently:

- `running` stays true, so every later `onTimer` re-arms at `MAX_TIMER_DELAY_MS` and returns early;
- no job runs again;
- the remaining jobs in that batch stay claimed and off the heap without ever being invoked.

CRUD still resolves and `status()` still reports `started: true`, so the failure is silent.

**There is no execution timeout.** Bounding the callback would need an execution timeout plus release of the remaining batch jobs, and a lease on `runningAtMs` (see `inFlight` below). Neither is implemented. stonyx-cron#35 described that work and was closed without a fix in the 2026-09 backlog reset. Until then, consumers bound their own callbacks (README § CronService).

### `inFlight`: stale claim or live claim

`src/service.ts` keeps a module-level `WeakSet<Job>` named `inFlight`. A job object is added when phase 1 claims it, and removed by phase 3's `finally` (or by the one hand-release on the `'removed'` path). Membership therefore means "a settle is still coming".

It exists because `start()` cannot otherwise tell a stale claim from a live one. Both are just a number in `job.state.runningAtMs`, and they need opposite treatment:

- A **stale** claim (its owner process is gone) must be released. Nothing else ever will release it, because there is no lease on the field, and left in place the job is dead forever while `status()` reports it healthy.
- A **live** claim must be left alone. Releasing it lets the timer start a second concurrent invocation of a job that is already running, which breaks the one-in-flight guarantee.

`inFlight` is module-level rather than per-instance on purpose:

- A second `CronService` handed the same live `Job` objects gets the same answer rather than guessing.
- Keying by identity means a deserialized row is correctly not a member, because a real process restart is what makes a claim provably stale.

It adds nothing to the published surface (`grep -c inFlight dist/service.d.ts` is 0). It also needs no test reset hook, because fresh per-test job objects cannot be members.

`start()` also throws on a row whose `state` is missing or frozen, rather than collapsing it into a `runningAtMs` read (README § Breaking changes, item 5).

**Known limit:** for a hung callback the settle is pending, not absent, so membership stays true forever:

- `start()` will not release that job, and `run()` answers `'already running'` forever.
- A batch job stranded that way is permanently dead in this process.
- Only a real process restart recovers it, because deserialization produces fresh objects that are not members.

Object identity cannot tell "hung forever" from "still running". That needs a lease on `runningAtMs`, which does not exist (see above). In-process recovery from a hung callback is not guaranteed, and no test asserts it.

## Two schedulers

Besides `CronService`, the package's default export is the `Cron` singleton in `src/main.ts` (`register` / `unregister` / `runDueJobs`). It has its own execution contract:

- callbacks are fire-and-forget (never awaited);
- a job is rescheduled before its callback is invoked;
- a per-job in-flight guard (`job.runningAtMs`) **skips** a due job whose previous invocation has not settled.

No `Cron` method returns a value that reports a skip, so a skip is invisible to the caller. That is why the stuck-job warning is reported ungated, on `log.warn`, once per stuck run. `Cron` has no timeout either: a callback that never settles disables that one job permanently. See [architecture.md § Error Handling](architecture.md#error-handling).
