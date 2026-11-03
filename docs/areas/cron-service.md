# Area: `CronService` — CRUD, run log, backoff, and the three-phase execution model

`CronService` (`src/service.ts`, published separately as `@stonyx/cron/service`) is a
distinct, heavier scheduler from `Cron` above. It is not a singleton — consumers
`new CronService()` and drive its lifecycle with `start()`/`stop()` — and it does not
share a scheduler, a heap, or a execution contract with `Cron`. The consumer-facing
contract (the `run()` result table, the concurrency guarantee, the breaking changes in
this line, and the `config.cron.log` channel differences between the two classes) is in
[README § CronService](../../README.md#cronservice). This page is the mechanism behind
that contract; the full write-up is [CronService Design](../service-design.md).

## What it adds over `Cron`

- **CRUD** (`add`/`update`/`remove`/`get`/`list`) over jobs with three schedule kinds —
  `at` (one-shot), `every` (drift-free recurring interval), and `cron` (5-field
  expression via the dependency-free parser in `src/cron-parser.ts`).
- **A run log** (`src/run-log.ts`): every execution records status, error, summary,
  timing and the next run time, per job, at a configurable depth.
- **Error backoff** (`src/job.ts`): consecutive failures push the next run out —
  30s, 60s, 5m, 15m, then 1h and capped there — without ever shortening the normal
  interval. A success resets the count.
- **A three-phase, lock-guarded execution model** (`src/locked.ts`): claim (locked) →
  invoke the consumer's `onJobDue` (not locked) → settle (locked). Because the
  consumer callback never runs while the lock is held, a callback that never settles
  cannot wedge `add`/`update`/`remove` — but it does still strand its own job
  (permanently, in-process) and, on the timer path, stops every later job in that
  batch from running. There is no execution timeout. See
  [CronService Design § What the phase split does not fix](../service-design.md#what-the-phase-split-does-not-fix-a-hung-callback-stops-the-timer).

## Why this is a separate area, not a variation on `Cron`

The two classes agree on one guarantee only — a job never runs concurrently with
itself — and diverge on everything else: ownership model (singleton vs. instantiated),
scheduling granularity (seconds vs. ms with cron expressions), observability (an
ungated log line vs. a typed `ExecuteResult` plus a run log), and internal visibility
convention (`Cron`'s helpers are public; `CronService`'s claim/settle pair uses
ECMAScript hard-private `#` members because they carry a lock-held precondition the
type system cannot express — see [Architecture § Private Members](../architecture.md#private-members--for-a-lock-held-precondition-module-functions-otherwise)).
Conflating them in documentation would hide exactly the distinctions a consumer needs
to pick the right one.

For the locking detail, the two claim paths (`run()` vs. the timer's batch claim), the
`inFlight` stale-vs-live claim tracking, and the residual hang behaviour, see
[CronService Design](../service-design.md) in full.
