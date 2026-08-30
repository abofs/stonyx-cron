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

## ~~`runOnInit` callback is not awaited~~ — RESOLVED (#36)

Both halves of this entry are fixed. `register(runOnInit)` and `runDueJobs` now
route through a single `safeInvoke` helper that catches synchronous throws and
asynchronous rejections identically.

The suggested fix recorded here — *"add `await` … and make `register()` async"* —
was **rejected**: `register()` must stay synchronous and `void` for its consumer
(`stonyx-orm/src/db.ts`), and `runDueJobs` must **not** await the callback, as
awaiting is what let one hung job starve the whole scheduler. See
`docs/architecture.md` § Error Handling for the shape that replaced it.

Deletion of this file is tracked by #41.
