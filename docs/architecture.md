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
  skipReported: boolean   // whether a still-running skip has been logged for this run
}
```

`runningAtMs` is the in-flight guard, and it lives **on the job object** rather
than in a scheduler-level set keyed by job key. That is deliberate: object
identity is invocation identity, so the settle handler of one invocation can
only ever release the guard it set, and a job removed by `unregister` takes its
guard with it. It mirrors `job.state.runningAtMs` in the service tier
(`markRunning` / `applyResult` / `isDue` in `src/job.ts`).

**Public Methods:**

**`register(key, callback, interval, runOnInit=false)`**
- Registers a new recurring job
- `key` (string): Unique job identifier
- `callback` (Function): Async function to execute on each trigger
- `interval` (string): Whole seconds between executions. **Throws** a `TypeError`
  if the value cannot be parsed as seconds — a cron expression belongs to
  `CronService`, not to this class. Values below `1` are clamped to `1` with a
  warning.
- `runOnInit` (boolean): Whether to run callback immediately (through
  `safeInvoke`, so a rejection is caught rather than fatal)

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
- Reschedules each job **before** invoking it, then invokes through `safeInvoke`
- Never awaits the callback — see "Error Handling" below
- Skips a job whose previous invocation has not settled (one warning per stuck run)
- Calls `scheduleNextRun()` when done

**`safeInvoke(job, runOnInit=false)`**
- The one place this class invokes a consumer callback
- Catches synchronous throws and asynchronous rejections identically
- Acquires and releases the job's `runningAtMs` in-flight guard

**`release(job)`** / **`report(level, message)`**
- Internal helpers of `safeInvoke`: clear a job's guard, and log without letting
  the logger's own failure escape as an unhandled rejection

**`parseInterval(interval)`**
- Parses an interval to whole seconds, floored at `1`; returns `null` if it
  cannot be parsed at all

**`setNextTrigger(job)`**
- Updates job's `nextTrigger` to `now + interval`, with the interval floored at
  `1` second. The floor is load-bearing, not cosmetic — see "Error Handling"
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
// CORRECT: Convert seconds to milliseconds for setTimeout
const delay = Math.max(0, nextJob.nextTrigger - getTimestamp()) * 1000;
this.timer = setTimeout(() => this.runDueJobs(), delay);
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

### Logging Patterns
**Always check config before logging:**
```javascript
if (config.debug) this.log('job has been triggered', job.key);
if (config.cron?.log) log.cron(`${tag} - ${text}:`);
```

**Use appropriate log methods:**
- `log.cron()` for informational cron messages
- `log.error()` for error conditions

### Error Handling
**Never let errors crash the scheduler — and never `await` a consumer callback:**

```javascript
// Reschedule FIRST, then invoke without awaiting. `runDueJobs` returns void and
// nothing here consumes the callback's result, so awaiting bought nothing and
// cost the scheduler: a callback that never settled left the job absent from the
// heap, starved every other job, and stopped the timer from re-arming.
this.setNextTrigger(job);
heap.push(job);

this.safeInvoke(job);
```

All callback invocation goes through `safeInvoke`. Do **not** add a second call
site — the guard, the catch and the error reporting all live there:

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

Two rules that fall out of this and are easy to break:

1. **Interpolate the error into the message.** `@stonyx/logs` reads a second
   argument as `logToFile`, not as a format argument, so `log.error(msg, err)`
   discards the error *and* forces a disk write on every failure.
2. **Keep the drain loop's termination invariant.** Because nothing awaits, the
   `while` loop in `runDueJobs` has no suspension point and `nextTrigger > now`
   is its only exit condition. An interval that does not advance `nextTrigger`
   (`NaN`, `0`, negative) spins the loop forever and blocks the event loop.
   `setNextTrigger` floors the interval at 1 second for exactly this reason.

### Time Handling
**Always use `getTimestamp()` for current time:**
```javascript
// CORRECT
const now = getTimestamp();
job.nextTrigger = getTimestamp() + (this.parseInterval(job.interval) ?? 1);

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
- `CRON_LOG`: Set to `false` to disable cron logging

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
