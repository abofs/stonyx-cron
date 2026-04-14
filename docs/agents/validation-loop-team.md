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
- **Async lock serialization:** All CRUD operations and timer processing go through `locked()` — validation must confirm that concurrent calls do not corrupt `jobs` Map or `heap` state
- **Error backoff escalation:** Backoff must escalate on consecutive errors and reset on success — validate the full sequence: 30s → 60s → 5m → 15m → 1h → stays at 1h
- **Auto-disable after 3 schedule errors:** `scheduleErrorCount` increments on `computeNextRunAtMs` failure and disables the job at 3 — validation should confirm the counter resets when the schedule is updated
- **One-shot lifecycle:** `at`-kind jobs must be disabled after execution and auto-deleted if `deleteAfterRun` is true — validation must confirm no heap entry remains after deletion
- **Timer capping at 60 seconds:** Even with a far-future next job, the timer re-arms at most 60s out — validation should confirm that a job added while the timer is sleeping for 60s gets picked up on the next tick

## Live Knowledge

- `removeFromHeap` is O(n log n) via full rebuild — this is acceptable for typical workloads but validation should note it as a scaling concern if job counts exceed expectations
- The `running` guard prevents re-entrant `onTimer` execution but re-arms at `MAX_TIMER_DELAY_MS` — validation should confirm the scheduler cannot die if `onJobDue` takes longer than 60 seconds
- `findDueJobs` pops items from the heap and only re-inserts them in `executeJob` after updating `nextRunAtMs` — if `executeJob` throws before re-insert, the job is lost from the heap; validation should confirm error handling covers this
- The cron parser treats both day-of-month and day-of-week restricted (non-wildcard) as OR — matching either satisfies the day check; this follows traditional cron semantics
- `Job.id` is generated via `crypto.randomUUID()` — there is no deduplication check; validation should treat duplicate names as valid (different IDs)
- `normalizeJobInput` is a defensive layer for AI-generated inputs — it converts flat params, coerces types, and applies defaults; validation should test malformed inputs that a human would never produce but an LLM might
