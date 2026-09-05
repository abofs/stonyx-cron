# SME Template: Validation Loop Team — stonyx-cron

> **Inherits from:** `beatrix-shared/docs/framework/templates/agents/validation-loop-team.md`
> Load the base template first, then layer this project-specific context on top.

## Project Context

**Repo:** `abofs/stonyx-cron`
**Framework:** Stonyx module (`@stonyx/cron`) — job scheduling for the Stonyx framework
**Domain:** Advanced cron/job scheduling with min-heap priority queue, three schedule types (at/every/cron), async locking, error backoff, run history, and pluggable execution

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (compiled to ESM) |
| Runtime | Node.js |
| Data Structure | Custom min-heap |
| Scheduling | Custom cron parser + interval/one-shot |
| Test | QUnit + Sinon |
| Build | tsc (src → dist, test → dist-test) |

## Architecture Patterns

- **Min-heap invariant is the scheduling backbone:** The heap must always have the earliest `nextTrigger` at index 0 — validation must confirm that `push`, `pop`, and `remove` maintain the heap property under all mutation sequences
- **Schedule computation correctness:** `computeNextRunAtMs` must always return a time strictly in the future (or undefined for expired one-shots) — validation should test boundary conditions: exactly-on-time, one-ms-before, one-ms-after, and timezone transitions (DST)
- **Async lock serialization:** All CRUD operations and the claim/settle phases of execution go through `locked()` — validation must confirm that concurrent calls do not corrupt `jobs` Map or `heap` state, AND that the consumer callback is never awaited under the lock (a never-settling `onJobDue` must leave `add`/`update`/`remove` fully responsive)
- **`start()` must never release a LIVE claim (#34):** this is the single invariant the class advertises — one in-flight invocation per job — and `start()` is the one place that writes to a rehydrated `row.state`. A stale claim MUST be released (nothing else reaps it) and a live one MUST be left alone (releasing it lets the timer launch a second concurrent invocation). The discriminator is the module-level `inFlight` WeakSet, not a `runningAtMs` read — the two cases are indistinguishable in that field. Validation must cover BOTH directions and confirm they die on disjoint tests: always-release and never-release must each turn the suite red, and each `inFlight` add/delete site must have its own killer. Because it is module-level, validation must also confirm the CROSS-INSTANCE case — a second `CronService` handed the same live `Job` objects must inherit the answer, not guess — and the frozen-row case, which must throw at the store boundary rather than be collapsed into a `runningAtMs` read
- **Error backoff escalation:** Backoff must escalate on consecutive errors and reset on success — validate the full sequence: 30s → 60s → 5m → 15m → 1h → stays at 1h
- **Auto-disable after 3 schedule errors:** `scheduleErrorCount` increments on `computeNextRunAtMs` failure and disables the job at 3 — validation should confirm the counter resets when the schedule is updated
- **One-shot lifecycle:** `at`-kind jobs must be disabled after execution and auto-deleted if `deleteAfterRun` is true — validation must confirm no heap entry remains after deletion
- **Timer capping at 60 seconds:** Even with a far-future next job, the timer re-arms at most 60s out — validation should confirm that a job added while the timer is sleeping for 60s gets picked up on the next tick

## Live Knowledge

- `removeFromHeap` is O(n log n) via full rebuild — this is acceptable for typical workloads but validation should note it as a scaling concern if job counts exceed expectations
- The `running` guard prevents re-entrant `onTimer` execution but re-arms at `MAX_TIMER_DELAY_MS` — validation should confirm the scheduler cannot die if `onJobDue` takes longer than 60 seconds
- `findDueJobs` pops items from the heap and the settle phase re-inserts them after updating `nextRunAtMs`. A claim with no matching settle is a permanently dead job — off the heap, `runningAtMs` set, `isDue` false forever and `run()` refused forever — so settle runs in a `finally` and the per-job handler in `onTimer` reports on `log.error`, which no config flag gates. Validation must confirm this holds when the error reporter itself throws
- `inFlight` membership means "a settle is still coming", which is a promise rather than a fact: a HUNG callback makes it permanently true, so `start()` refuses to release that job and `run()` answers `'already running'` forever. Only a real process restart recovers it, because deserialization produces fresh objects that are not members. Validation should treat "recoverable in-process" as explicitly NOT guaranteed here and not write a test asserting it — see #35
- The cron parser treats both day-of-month and day-of-week restricted (non-wildcard) as OR — matching either satisfies the day check; this follows traditional cron semantics
- `Job.id` is generated via `crypto.randomUUID()` — there is no deduplication check; validation should treat duplicate names as valid (different IDs)
- `normalizeJobInput` is a defensive layer for AI-generated inputs — it converts flat params, coerces types, and applies defaults; validation should test malformed inputs that a human would never produce but an LLM might
