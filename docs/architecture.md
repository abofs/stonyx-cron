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
  key: string,           // Unique identifier for the job
  callback: Function,    // Async function to execute
  interval: number,      // Interval in seconds
  nextTrigger: number    // Unix timestamp in seconds when job should run
}
```

**Public Methods:**

**`register(key, callback, interval, runOnInit=false)`**
- Registers a new recurring job
- `key` (string): Unique job identifier
- `callback` (Function): Async function to execute on each trigger
- `interval` (number): Time in seconds between executions
- `runOnInit` (boolean): Whether to run callback immediately

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
- Executes job callbacks with error handling
- Reschedules each job after execution
- Calls `scheduleNextRun()` when done

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

### Private Members — `#` for a lock-held precondition, module functions otherwise

`CronService`'s `#claimJob`, `#settleJob` and `#executeClaimed` (#34) are the **first** use of ECMAScript hard-private anywhere in the `@stonyx/*` ecosystem. The existing precedents are `stonyx-orm`'s TypeScript `private` modifier and `stonyx-sockets`' bare `_` prefix. This records the ruling so the next module does not have to re-derive it.

**The house rule: `#` when publishing the member would be a safety hazard, not merely untidy.** The three above take or release a claim, and each has a precondition — "must be called while holding the lock" — that the type system cannot express. A published `claimJob` is a supported way to perform `markRunning` + `removeFromHeap` with no guaranteed settle, which strands the job permanently: `isDue` is false forever once `runningAtMs` is set, `run()` refuses forever, `start(initialJobs)` rehydrates the state verbatim so it survives a restart, and `status()` reports the job healthy throughout. Removing that from the published surface is the whole point.

Two things to know before reaching for it:

- **The nominal-typing cost is inherent to class members, not to `#`.** Both options break structural assignability. Measured on this repo: `#private` produces `TS2741: Property '#private' is missing`; switching the same three to TypeScript `private` produces `TS2739: ... missing the following properties: executeClaimed, claimJob, settleJob` — the same break, *and* it leaks all three names into `dist/service.d.ts` as `private claimJob;`. Between the two class-member options `#` is strictly better. Note the break is one-directional: `extends` and assigning a real instance to a consumer's own interface both still compile.
- **Module-level functions are the only option that preserves structural typing, and they are this repo's dominant helper idiom** — `job.ts`, `schedule.ts` and `normalize.ts` are entirely module-level functions over a `Job`, as is `describeError()` in `service.ts`. **Prefer them.** Reach for `#` only when the helper must close over private instance state, as the claim/settle pair does.

Whichever is chosen, guard it: `test/unit/publish-surface-test.ts` asserts against the emitted `dist/service.d.ts` that `#private;` is present and that the three names are absent, because this repo has already been burned once by a published-surface property regressing silently (#30).

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
**Never let errors crash the scheduler:**
```javascript
try {
  await job.callback();
} catch (err) {
  log.error(`Cron job "${job.key}" failed:`, err);
}
// Always reschedule job, even after error
this.setNextTrigger(job);
heap.push(job);
```

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
