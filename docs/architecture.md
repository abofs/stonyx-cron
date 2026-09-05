# Architecture & Core Components

## Core Components Deep Dive

### Cron Class (`stonyx-cron/src/main.js`)

**Properties:**
```javascript
jobs = {};          // Object mapping job keys to job objects
heap = new MinHeap(); // Priority queue of jobs
timer = null;       // setTimeout handle for next scheduled run
```

**Job Object Schema:**
```javascript
{
  key: string,            // Unique identifier for the job
  callback: Function,     // Function to execute; may be sync or async
  interval: string,       // Interval in whole seconds, as a string
  nextTrigger: number,    // Unix timestamp in seconds when job should run
  runningAtMs: number,    // ms timestamp of the in-flight invocation; undefined when idle
  skipReported: boolean   // whether a still-running skip has been reported for this run
}
```

`runningAtMs` and `skipReported` are **optional** on the emitted type. `CronJob`
is not exported by name but is structurally reachable through `jobs`, `heap` and
`setNextTrigger`, so making either one required is a breaking change for any
consumer that builds a job object in TypeScript. Keep new job state optional.

`runningAtMs` is the in-flight guard, and it lives **on the job object** rather
than in a scheduler-level set keyed by job key. That is deliberate: object
identity is invocation identity, so the settle handler of one invocation can only
ever release the guard it set, and a job removed by `unregister` takes its guard
with it. It mirrors `job.state.runningAtMs` in the service tier (`markRunning` /
`applyResult` / `isDue` in `src/job.ts`). Note that `CronService.running` is a
*class-level* re-entrancy flag on the timer and a different concept entirely.

**Accepted residual — concurrency across unregister/re-register.** Because a
replacement job object carries a fresh guard, unregistering a key whose
invocation is still pending and re-registering it lets the replacement run
alongside the abandoned invocation (measured: 2 concurrent). The same-job
guarantee therefore holds for the lifetime of a **registration**, not of a key.
It is accepted because bounding it would reintroduce the defect this class was
fixed for: serialising a replacement against an invocation the consumer has
explicitly abandoned is exactly what produces a permanently dead job. It is also
the only recovery path from a stuck job. Bounding the callback remains the
consumer's responsibility.

**Public Methods:**

**`register(key, callback, interval, runOnInit=false)`**
- Registers a new recurring job
- `key` (string): Unique job identifier
- `callback` (Function): Async function to execute on each trigger
- `interval` (number): Time in seconds between executions
- `runOnInit` (boolean): Whether to run callback immediately
- The `runOnInit` invocation goes through `invokeJob` — the same single call
  site the drain loop uses — and `scheduleNextRun()` is called from a `finally`,
  so a job is never left registered-but-unscheduled

**`unregister(key)`**
- Removes a job from the scheduler
- Deletes from `jobs` object and removes from heap
- Reschedules next run after removal

**`scheduleNextRun()`**
- Clears existing timer
- Peeks at next job in heap
- Calculates delay: `(nextTrigger - now) * 1000` (converts seconds to milliseconds)
- Sets setTimeout for next job execution

**`runDueJobs()`**
- Processes all jobs with `nextTrigger <= now`
- Reschedules each job **before** invoking it, then invokes through `invokeJob`
- Never awaits the callback — see "Error Handling" below
- Skips a job whose previous invocation has not settled, and reports that skip
  once per stuck run on an **ungated** channel
- Calls `scheduleNextRun()` from a `finally`, so the scheduler re-arms on every
  exit from the drain loop

**`invokeJob(job, runOnInit=false)`**
- The one place this class invokes a consumer callback
- Catches synchronous throws and asynchronous rejections identically
- Acquires and releases the job's `runningAtMs` in-flight guard

**`report(level, message)`** / **`release(job)`**
- Helpers of `invokeJob`: log without letting the logger's own failure escape as
  an unhandled rejection, and clear a job's in-flight guard

**`setNextTrigger(job)`**
- Updates job's `nextTrigger` to `now + interval`
- Uses `getTimestamp()` which returns **seconds**, not milliseconds

**`log(text, key=null)`**
- Conditional logging based on `config.cron?.log`
- Formats messages as `Cron::${key} - ${text}:` or `Cron - ${text}:`

### MinHeap Class (`stonyx-cron/src/min-heap.js`)

**Properties:**
```javascript
items = [];  // Array backing the heap
```

**Public Methods:**

**`push(job)`**
- Adds job to end of array
- Bubbles up to maintain heap property

**`pop()`**
- Removes and returns root (minimum `nextTrigger`)
- Replaces root with last item
- Bubbles down to restore heap property

**`peek()`**
- Returns root without removing it
- O(1) access to next job to run

**`remove(job)`**
- Finds job by reference equality (`indexOf`)
- Replaces with last item
- Bubbles both up and down to restore heap property

**`isEmpty()`**
- Returns `true` if `items.length === 0`

**Internal Methods:**

**`bubbleUp()`**
- Moves last item up tree until heap property is satisfied
- Compares `nextTrigger` values with parent

**`bubbleDown()`**
- Moves root down tree, swapping with smallest child
- Maintains min-heap property

---

## Dependencies & Integration

### Stonyx Framework Integration
```javascript
import config from 'stonyx/config';  // Configuration system
import log from 'stonyx/log';        // Logging system
import { setupIntegrationTests } from "stonyx/test-helpers";  // Test utilities
```

### External Dependencies
```javascript
import { getTimestamp } from "@stonyx/utils/date";  // Time utilities
import QUnit from 'qunit';                          // Test framework
import sinon from 'sinon';                          // Test spies/stubs/fake timers
```

### Critical Time Handling Detail
**`getTimestamp()` returns Unix timestamps in SECONDS, not milliseconds.**

This affects:
- Job `interval` values (specified in seconds)
- Job `nextTrigger` values (stored in seconds)
- Delay calculation in `scheduleNextRun()`: must multiply by 1000 for `setTimeout`

```javascript
// CORRECT: Convert seconds to milliseconds for setTimeout.
// Note the terminal `.catch`: `runDueJobs` is async, so anything that escapes
// it would otherwise surface as an unhandled rejection raised from a bare
// timer callback. See Rule 3 under Error Handling below.
const delay = Math.max(0, nextJob.nextTrigger - getTimestamp()) * 1000;
this.timer = setTimeout(() => {
  this.runDueJobs().catch(err => {
    this.report('error', `Cron scheduler tick failed: ${describeError(err)}`);
  });
}, delay);
```

---

## Code Patterns & Conventions

### Module System
All modules use ES Module syntax with default exports:
```javascript
export default class Cron { ... }
export default class MinHeap { ... }
export default { log: true, logColor: '#888' };  // config
```

Imports use full package paths:
```javascript
import Cron from '@stonyx/cron';
import MinHeap from '@stonyx/cron/min-heap';
```

### Private Members — `#` for a lock-held precondition, module functions otherwise

`CronService`'s `#claimJob`, `#settleJob` and `#executeClaimed` (#34) are the **first** use of ECMAScript hard-private anywhere in the `@stonyx/*` ecosystem. The existing precedents are `stonyx-orm`'s TypeScript `private` modifier and `stonyx-sockets`' bare `_` prefix. This records the ruling so the next module does not have to re-derive it.

**The house rule: `#` when publishing the member would be a safety hazard, not merely untidy.** The three above take or release a claim, and each has a precondition — "must be called while holding the lock" — that the type system cannot express. A published `claimJob` is a supported way to perform `markRunning` + `removeFromHeap` with no guaranteed settle, which strands the job permanently: `isDue` is false forever once `runningAtMs` is set, `run()` refuses forever, `start(initialJobs)` rehydrates the state verbatim so it survives a restart, and `status()` reports the job healthy throughout. Removing that from the published surface is the whole point.

Two things to know before reaching for it:

- **The nominal-typing cost is inherent to class members, not to `#`.** Both options break structural assignability. Measured on this repo: `#private` produces `TS2741: Property '#private' is missing`; switching the same three to TypeScript `private` produces `TS2739: ... missing the following properties: executeClaimed, claimJob, settleJob` — the same break, *and* it leaks all three names into `dist/service.d.ts` as `private claimJob;`. Between the two class-member options `#` is strictly better. Note the break is one-directional: `extends` and assigning a real instance to a consumer's own interface both still compile.
- **Module-level functions are the only option that preserves structural typing, and they are this repo's dominant helper idiom** — `job.ts`, `schedule.ts` and `normalize.ts` are entirely module-level functions over a `Job`, as is `describeError()` in `service.ts`. **Prefer them.** Reach for `#` only when the helper must close over private instance state, as the claim/settle pair does.

Whichever is chosen, guard it: `test/unit/publish-surface-test.ts` asserts against the emitted `dist/service.d.ts` that `#private;` is present and that the three names are absent, because this repo has already been burned once by a published-surface property regressing silently (#30).

#### Two `describeError` helpers, deliberately not shared (#34 / #36)

`src/main.ts` and `src/service.ts` each carry a private `describeError`. That is
a **recorded decision**, not drift, and neither should be lifted into a shared
module: they render for different destinations.

| | `Cron.describeError` (`main.ts`) | `CronService.describeError` (`service.ts`) |
| :-- | :-- | :-- |
| returns | `err.stack ?? \`${err.name}: ${err.message}\`` | `String(err.message)` |
| only destination | a log line | `ExecuteResult.error` **and** a run-log row **and** a log line |
| non-`Error` fallback | `String(err)` | `String(err)` |
| un-renderable fallback | `'<thrown value could not be rendered>'` | `'unknown error'` |

The divergence follows from the destination. `Cron` is fire-and-forget and
returns `void`, so the log is the *only* channel a failure can ever reach and a
full stack is the right payload. `CronService` returns the string to the caller
as `ExecuteResult.error` and persists it in a bounded per-job run log, so a
stack would put an unbounded multi-kilobyte blob into every stored failure and
into a value consumers compare and display. The log line is a third consumer,
not the primary one, and it gets the same string through `forLog`.

Both must be **total** — every read of a consumer-supplied thrown value can
throw (`instanceof` runs a proxy trap, `message`/`stack`/`name` can be throwing
accessors, `String(Object.create(null))` throws outright), and both run inside
the catch whose whole job is to stop a callback failure from reaching the
scheduler. In `CronService` the `message` read must be *inside* the `try`:
`Error.prototype.message` is typed `string`, so TypeScript cannot see a throwing
getter and the coercion would otherwise be deferred to the caller's template
literal, outside every guard — which made `run()` reject instead of returning an
`ExecuteResult`.

Anything interpolated into a log line is newline-flattened and length-capped
first (`forLog` in `service.ts`); chronicle writes `${timestamp} ${content}\n`
to a newline-delimited file, so an unflattened value forges a complete, well-
formed record. Job names and error text are both consumer- or model-controlled.

**Internal-helper visibility likewise differs by class and is intentional.**
`CronService` uses `#private` for its claim/settle pair because those carry a
lock-held precondition the type system cannot express (see above). `Cron`'s
`invokeJob`/`report`/`release` are public: they have no such precondition, and
`Cron`'s members are exposed structurally through `jobs`, `heap` and
`setNextTrigger`, so hard-privating them would be a breaking type change for no
safety gain.

### Logging Patterns
**Always check config before logging:**
```javascript
if (config.debug) this.log('job has been triggered', job.key);
if (config.cron?.log) log.cron(`${tag} - ${text}:`);
```

**Use appropriate log methods:**
- `log.cron()` for informational cron messages (gated by `config.cron.log`)
- `log.error()` / `log.warn()` via `report()` for error and wedged-job conditions
  — **ungated**, because these are the module's only signal that work was dropped

The `if (config.debug)` wrapper applies to informational chatter only. Do not put
a dropped execution behind it, or behind `config.cron.log`.

### Error Handling
**Never let errors crash the scheduler — and never `await` a consumer callback:**

```javascript
// Reschedule FIRST, then invoke without awaiting. `runDueJobs` returns void and
// nothing here consumes the callback's result, so awaiting bought nothing and
// cost the scheduler: a callback that never settled left the job absent from the
// heap, starved every other job, and stopped the timer from re-arming.
this.setNextTrigger(job);
heap.push(job);

this.invokeJob(job);
```

All callback invocation goes through `invokeJob`. Do **not** add a second call
site — the in-flight guard, the catch and the error reporting all live there:

```javascript
try {
  const result = job.callback();

  if (result && typeof result.then === 'function') {
    Promise.resolve(result)
      // Braces: returning the report would put its promise back into the chain,
      // and `.finally` passes a rejection straight through.
      .catch(err => { this.report('error', `... ${describeError(err)}`); })
      .finally(() => { this.release(job); })
      .catch(() => {});          // a throwing handler must not escape either
    return;
  }

  this.release(job);
} catch (err) {
  this.release(job);
  this.report('error', `... ${describeError(err)}`);
}
```

Five rules that fall out of this and are easy to break:

1. **Interpolate the error into the message.** `@stonyx/logs` reads a second
   argument as `logToFile`, not as a format argument, so `log.error(msg, err)`
   discards the error *and* forces a disk write on every failure. `src/types/stonyx.d.ts`
   carries the real signature so this fails to compile rather than failing silently.
2. **Everything that touches the callback stays inside the `try`** — including
   the `typeof result.then` probe. A callback may return an object whose `then`
   is a throwing getter; reading it outside the guard aborts the drain loop
   before `scheduleNextRun()`, which is the original defect again.
3. **`scheduleNextRun()` runs in a `finally`** at *both* call sites that invoke
   a callback — `runDueJobs` and `register` — and the timer callback in
   `scheduleNextRun` carries a terminal `.catch`. The invariant is that the
   scheduler always re-arms, even if the loop body throws. `register` is the
   easier one to forget: it has no outer loop, so an escape there leaves the job
   in `jobs` and in the heap with no timer behind it.
4. **`describeError` must be total.** It runs *inside* the catch whose purpose
   is to keep a callback failure away from the scheduler, and every read it
   performs is on a consumer-controlled value: `instanceof` runs a proxy's
   `getPrototypeOf` trap, `stack`/`name`/`message` can be accessors, and
   `String(Object.create(null))` throws outright. A throw from the reporting
   path escapes the guard it is inside and is the original defect again, so the
   whole body sits in a `try` with a non-re-entrant fallback string.
5. **Report a wedged job on an ungated channel, once per stuck run.** `this.log`
   returns early on `!config.cron?.log`, and a lost execution reported through a
   channel a config flag can silence is indistinguishable from a healthy
   scheduler. `report('warn', ...)` is ungated; `skipReported` bounds it to one
   line per stuck run (it was 43,200 lines/day per hung job at a 1s interval,
   which pushes an operator to turn the signal off).

### Time Handling
**Always use `getTimestamp()` for current time:**
```javascript
// CORRECT
const now = getTimestamp();
job.nextTrigger = getTimestamp() + parseInt(job.interval, 10);

// WRONG - don't use Date.now() or other time sources
const now = Date.now(); // WRONG: milliseconds instead of seconds
```

---

## Configuration Reference

### Module Configuration
**File:** `stonyx-cron/config/environment.js`

```javascript
const { CRON_LOG } = process;

export default {
  log: CRON_LOG ?? true,    // Enable/disable cron logging
  logColor: '#888',         // Color for cron logs
}
```

**Environment Variable:**
- `CRON_LOG`: Set to `false` to disable cron logging. **Currently inert** —
  `config/environment.js` destructures `CRON_LOG` from `process`, not
  `process.env`, so the value is always `undefined` and `log` defaults to `true`.
  Tracked in abofs/stonyx-cron#56. This is one reason the wedged-job signal does
  not route through `config.cron.log`.

### Using Configuration in Code
```javascript
import config from 'stonyx/config';

// Access cron config
if (config.cron?.log) {
  log.cron('message');
}

// Access debug flag (from main Stonyx config)
if (config.debug) {
  this.log('debug message');
}
```
