# stonyx-cron Project Structure

## 1. Project Overview

**stonyx-cron** is a lightweight async job scheduler for the Stonyx framework that uses a min-heap priority queue for efficient job scheduling.

**Core Purpose:**
- Schedule and execute async jobs at specified intervals
- O(log n) scheduling efficiency via min-heap priority queue
- Robust error handling that never crashes the scheduler
- Configuration-driven logging aligned with Stonyx patterns

**Technology Stack:**
- **Module System:** ES Modules (ESM)
- **Testing:** QUnit with Sinon for spies/stubs/fake timers
- **Dependencies:** Stonyx framework, @stonyx/utils/date
- **Node Version:** Specified in `.nvmrc`

---

## 2. Architecture & Design Decisions

### Singleton Pattern
The `Cron` class uses a singleton pattern to ensure only one scheduler instance exists across the entire application. The constructor returns the existing instance if one has already been created.

```javascript
constructor() {
  if (Cron.instance) return Cron.instance;
  Cron.instance = this;
}
```

**Rationale:** Prevents multiple competing schedulers and ensures consistent job management.

### Min-Heap Priority Queue
Jobs are stored in a min-heap ordered by `nextTrigger` timestamp, allowing O(log n) insertion and O(1) peek of the next job to run.

**Heap Property:** Parent nodes have earlier `nextTrigger` values than their children, so the root is always the next job to execute.

### Async Job Execution Strategy
- Jobs are executed with `await job.callback()` to handle async operations
- Errors are caught and logged but never crash the scheduler
- After execution (success or failure), jobs are rescheduled and re-inserted into the heap
- The scheduler reschedules itself after processing all due jobs

### Configuration-Driven Logging
Logging follows Stonyx patterns:
- Check `config.debug` before debug logs
- Check `config.cron?.log` before cron-specific logs
- Use `log.cron()` for cron messages, `log.error()` for errors

---

## 3. File Structure

```
stonyx-cron/
├── .claude/
│   └── project-structure.md          - This document
├── .github/
│   └── workflows/                     - CI/CD configuration
├── config/
│   └── environment.js                 - Cron module configuration
├── src/
│   ├── main.js                        - Cron class (singleton scheduler)
│   └── min-heap.js                    - MinHeap priority queue implementation
├── test/
│   └── unit/
│       ├── cron-test.js               - Cron class unit tests
│       └── min-heap-test.js           - MinHeap unit tests
├── package.json                       - Package metadata and exports
├── stonyx-bootstrap.cjs               - QUnit test bootstrap
├── README.md                          - Project documentation
├── LICENSE.md                         - Apache 2.0 license
├── .nvmrc                             - Node version specification
└── .gitignore                         - Git ignore rules
```

---

## 4. Core Components Deep Dive

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

## 5. Dependencies & Integration

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

## 6. Code Patterns & Conventions

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

## 7. Testing Guidelines

### Test Structure
Tests are located in `stonyx-cron/test/unit/` and use QUnit modules:

```javascript
import QUnit from 'qunit';
import sinon from 'sinon';
import { setupIntegrationTests } from "stonyx/test-helpers";

const { module, test } = QUnit;

module('[Unit] Cron', function (hooks) {
  setupIntegrationTests(hooks);

  let cron, clock;

  hooks.beforeEach(function () {
    clock = sinon.useFakeTimers({ shouldAdvanceTime: false });
    cron = new Cron();
  });

  hooks.afterEach(function () {
    sinon.restore();
  });

  test('test description', async function (assert) {
    // Test implementation
  });
});
```

### Fake Timers Pattern (CRITICAL)
**Always use fake timers for time-based tests:**

```javascript
// Setup in beforeEach
clock = sinon.useFakeTimers({ shouldAdvanceTime: false });

// Advance time synchronously
clock.tick(5000);  // Advance 5 seconds

// For async operations, use tickAsync
clock.tick(5000);
await clock.tickAsync(0);  // Process async callbacks

// Cleanup in afterEach
sinon.restore();
```

**Why `shouldAdvanceTime: false`?**
Prevents real time from interfering with fake time, ensuring deterministic tests.

### Spies & Stubs Patterns
```javascript
// Spy on function calls
const cb = sinon.spy();
cron.register('job1', cb, 5);
assert.ok(cb.calledOnce, 'Callback executed once');

// Stub methods
const stub = sinon.stub().rejects(new Error('boom'));
cron.register('jobErr', stub, 1);

// Spy on existing methods
const logSpy = sinon.spy(log, 'cron');
cron.log('test message');
assert.ok(logSpy.calledOnce, 'Log called');
```

### Test Coverage Expectations
Tests should cover:
- Job registration and execution
- Rescheduling behavior
- Unregistration
- Error handling
- Configuration-driven logging
- Edge cases (empty heap, multiple jobs, etc.)

### Running Tests
```bash
npm test  # Runs: qunit --require ./stonyx-bootstrap.cjs
```

---

## 8. Extension Points

This section provides specific guidance for common feature additions.

### Adding Job Metadata

**Where:** `stonyx-cron/src/main.js`

**Pattern:**
```javascript
// In register method, extend job object:
register(key, callback, interval, runOnInit=false, metadata={}) {
  const job = {
    callback,
    interval,
    key,
    metadata  // Add metadata field
  };
  this.jobs[key] = job;
  // ... rest of method
}

// Access metadata in runDueJobs or other methods:
const { metadata } = job;
if (metadata.priority === 'high') {
  // Handle high priority jobs differently
}
```

**Tests to add:** Verify metadata is stored and accessible in job object.

### Adding Priority Levels

**Where:**
- `stonyx-cron/src/main.js` (Cron class)
- `stonyx-cron/src/min-heap.js` (MinHeap comparison)

**Pattern:**
```javascript
// Option 1: Secondary sort on priority
// In min-heap.js bubbleUp/bubbleDown, change comparison:
if (this.items[idx].nextTrigger < this.items[parentIdx].nextTrigger ||
    (this.items[idx].nextTrigger === this.items[parentIdx].nextTrigger &&
     this.items[idx].priority > this.items[parentIdx].priority)) {
  // Swap
}

// Option 2: Offset nextTrigger by priority
// In main.js setNextTrigger:
setNextTrigger(job) {
  const priorityOffset = job.priority || 0;
  job.nextTrigger = getTimestamp() + parseInt(job.interval, 10) - priorityOffset;
}
```

**Considerations:**
- Option 1 maintains exact timing but adds complexity to heap
- Option 2 is simpler but slightly alters execution timing
- Add `priority` field to job object schema

**Tests to add:** Jobs with higher priority run before lower priority when due at same time.

### Adding Job Statistics

**Where:** `stonyx-cron/src/main.js`

**Pattern:**
```javascript
// Extend job object with stats:
register(key, callback, interval, runOnInit=false) {
  const job = {
    callback,
    interval,
    key,
    stats: {
      runCount: 0,
      lastRun: null,
      lastError: null,
      errorCount: 0
    }
  };
  // ...
}

// Update stats in runDueJobs:
async runDueJobs() {
  // ...
  try {
    await job.callback();
    job.stats.runCount++;
    job.stats.lastRun = getTimestamp();
  } catch (err) {
    job.stats.errorCount++;
    job.stats.lastError = err.message;
    log.error(`Cron job "${job.key}" failed:`, err);
  }
  // ...
}

// Add method to retrieve stats:
getJobStats(key) {
  return this.jobs[key]?.stats;
}
```

**Tests to add:** Verify stats increment correctly on success/error.

### Adding Persistence

**Where:** `stonyx-cron/src/main.js`

**Pattern:**
```javascript
// Add save/load methods:
async saveJobs() {
  const jobData = Object.values(this.jobs).map(job => ({
    key: job.key,
    interval: job.interval,
    // Don't save callback - must be re-registered
  }));
  // Write to file/database
}

async loadJobs(callbacks) {
  const jobData = // Read from file/database
  jobData.forEach(({ key, interval }) => {
    if (callbacks[key]) {
      this.register(key, callbacks[key], interval);
    }
  });
}
```

**Considerations:**
- Cannot serialize callbacks - must be re-registered on load
- Save job metadata, intervals, and keys
- Consider saving `nextTrigger` to maintain schedule across restarts

**Tests to add:** Verify jobs can be saved and restored with same intervals.

### Adding One-Time Jobs

**Where:** `stonyx-cron/src/main.js`

**Pattern:**
```javascript
// Add oneTime flag to job schema:
register(key, callback, interval, runOnInit=false, oneTime=false) {
  const job = { callback, interval, key, oneTime };
  // ...
}

// Modify runDueJobs to unregister one-time jobs:
async runDueJobs() {
  const now = getTimestamp();
  const { heap } = this;

  while (!heap.isEmpty() && heap.peek().nextTrigger <= now) {
    const job = heap.pop();

    try {
      await job.callback();
    } catch (err) {
      log.error(`Cron job "${job.key}" failed:`, err);
    }

    if (job.oneTime) {
      delete this.jobs[job.key];  // Don't reschedule
      if (config.debug) this.log('one-time job completed', job.key);
    } else {
      this.setNextTrigger(job);
      heap.push(job);
    }
  }

  this.scheduleNextRun();
}
```

**Tests to add:** One-time jobs execute once and are not rescheduled.

---

## 9. Configuration Reference

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

---

## 10. Package Exports

**File:** `stonyx-cron/package.json`

```json
{
  "exports": {
    ".": "./src/main.js",
    "./min-heap": "./src/min-heap.js"
  }
}
```

**Usage:**
```javascript
// Import Cron class (default export)
import Cron from '@stonyx/cron';

// Import MinHeap class (for advanced usage)
import MinHeap from '@stonyx/cron/min-heap';
```

---

## 11. Development Workflow

### Local Development
```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with specific Node version
nvm use
npm test
```

### Test-Driven Development
1. Write failing test in `stonyx-cron/test/unit/`
2. Implement feature in `stonyx-cron/src/`
3. Run `npm test` to verify
4. Refactor if needed

### CI/CD
- GitHub Actions workflows in `.github/workflows/`
- Runs tests on push/PR
- Publishes to npm on version tags

### Publishing
```bash
# Bump version
npm version patch|minor|major

# Publish to npm (if you have access)
npm publish
```

---

## 12. Common Pitfalls & Gotchas

### Time Units Confusion
**Pitfall:** Mixing seconds and milliseconds

**Correct:**
```javascript
// getTimestamp() returns SECONDS
const now = getTimestamp();
job.interval = 5;  // 5 seconds
job.nextTrigger = now + 5;  // 5 seconds from now

// setTimeout expects MILLISECONDS
const delay = (job.nextTrigger - now) * 1000;
setTimeout(callback, delay);
```

**Wrong:**
```javascript
// DON'T DO THIS
const delay = job.nextTrigger - getTimestamp();  // Missing * 1000
setTimeout(callback, delay);  // Will run almost immediately!
```

### Singleton Behavior
**Pitfall:** Creating multiple Cron instances unexpectedly

**Behavior:**
```javascript
const cron1 = new Cron();
const cron2 = new Cron();
console.log(cron1 === cron2);  // true - same instance!
```

**Implication:** Registering jobs on any instance affects the same scheduler.

### Job Callback Async Handling
**Pitfall:** Not awaiting async callbacks

**Correct:**
```javascript
cron.register('job', async () => {
  await someAsyncOperation();
}, 10);
```

The scheduler awaits the callback, so errors are caught properly.

**Wrong:**
```javascript
cron.register('job', () => {
  someAsyncOperation();  // Not awaited - errors won't be caught!
}, 10);
```

### Heap Reference Equality
**Pitfall:** Modifying job objects outside the scheduler

**Issue:**
```javascript
const job = cron.jobs['myJob'];
job.interval = 20;  // This doesn't update the heap!
```

**Solution:** Always use `unregister` then `register` to update job properties.

### Test Isolation
**Pitfall:** Tests interfering with each other due to singleton

**Solution:**
```javascript
hooks.beforeEach(function () {
  clock = sinon.useFakeTimers({ shouldAdvanceTime: false });
  cron = new Cron();  // Gets singleton

  // Clear previous test's jobs
  Object.keys(cron.jobs).forEach(key => cron.unregister(key));
});

hooks.afterEach(function () {
  sinon.restore();  // Restores real timers
});
```

---

## 13. Future Enhancement Opportunities

Ideas aligned with current architecture:

1. **Job Prioritization** - Add priority levels for jobs due at same time
2. **Persistence Layer** - Save/restore jobs across restarts
3. **Job Statistics** - Track run counts, errors, execution time
4. **Job Dependencies** - Wait for other jobs before running
5. **Cron Expression Support** - Use cron syntax instead of intervals
6. **Job Timeout** - Cancel jobs that run too long
7. **Pause/Resume** - Temporarily stop/start the scheduler
8. **Job Groups** - Batch operations on related jobs
9. **Event Emitters** - Emit events on job lifecycle (start, complete, error)
10. **Rate Limiting** - Limit concurrent job execution

All enhancements should maintain:
- Zero-crash guarantee (catch all errors)
- O(log n) scheduling efficiency
- Singleton pattern
- Configuration-driven logging

---

## 14. Related Resources

### Stonyx Framework
- Main repository: https://github.com/abofs/stonyx
- Configuration patterns: See `stonyx/config` documentation
- Logging patterns: See `stonyx/log` documentation
- Test helpers: See `stonyx/test-helpers` documentation

### Testing
- QUnit documentation: https://qunitjs.com/
- Sinon documentation: https://sinonjs.org/
- Fake timers: https://sinonjs.org/releases/latest/fake-timers/

### Data Structures
- Min-heap algorithm: https://en.wikipedia.org/wiki/Binary_heap
- Priority queue patterns: See MinHeap implementation

### Project Repository
- GitHub: https://github.com/abofs/stonyx-cron
- Issues: https://github.com/abofs/stonyx-cron/issues
- License: Apache 2.0

---

## Document Maintenance

**Last Updated:** 2026-01-31
**Version:** 1.0.0
**Maintainer:** Project owner (update when structure changes significantly)

**When to Update:**
- Major architectural changes
- New core components added
- Extension patterns change
- New configuration options
- Breaking changes to API
