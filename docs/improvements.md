# Improvement Opportunities

## `register()` does not validate duplicate keys

**File:** `src/main.js`, `register()` method (line 67)

When `register()` is called with a key that already exists, it overwrites the entry in `this.jobs[key]` but never removes the old job object from the heap. The old entry remains orphaned in the heap and will still trigger when its `nextTrigger` time arrives, even though it is no longer tracked in `this.jobs`.

```javascript
register(key, callback, interval, runOnInit=false) {
  const job = { callback, interval, key };
  this.jobs[key] = job;       // overwrites old reference
  this.setNextTrigger(job);
  this.heap.push(job);        // pushes new entry, old entry still in heap
  // ...
}
```

**Impact:** The orphaned heap entry will fire its old callback on the old schedule. Since it is no longer in `this.jobs`, it cannot be unregistered.

**Suggested fix:** Check for an existing key and call `unregister(key)` before registering, or throw an error if the key is already registered.

---

## `runOnInit` callback is not awaited

**File:** `src/main.js`, `register()` method (line 79)

When `runOnInit` is `true`, the callback is invoked synchronously without `await`:

```javascript
if (runOnInit) {
  try {
    callback();          // not awaited
  } catch (err) {
    log.error(`Cron job "${key}" failed on init:`, err);
  }
}
```

This is inconsistent with `runDueJobs()`, which does await the callback:

```javascript
try {
  await job.callback();  // awaited
} catch (err) {
  log.error(`Cron job "${job.key}" failed:`, err);
}
```

**Impact:** If the callback is async and throws, the rejection will not be caught by the `try/catch` block in `register()`. The error becomes an unhandled promise rejection instead of being logged.

**Suggested fix:** Add `await` to the `callback()` call in the `runOnInit` branch and make `register()` async, or wrap in a `.catch()` handler.
