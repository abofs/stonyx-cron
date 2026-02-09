# Extension Guide

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
