# Area: `Cron` — the fire-and-forget interval registry

`Cron` (default export, `src/main.ts`) is a singleton that registers callbacks against
a plain seconds-based interval and runs them off a `setTimeout` driven by a min-heap of
next-trigger times. It does not CRUD, does not persist, and does not await the
callbacks it invokes — see [README § Public Methods](../../README.md#public-methods) for
the consumer-facing contract (what `register`/`unregister` guarantee, the skip-and-warn
behaviour for a stuck job, and the known re-registration limitation).

For the full mechanism — the `Cron` and `MinHeap` class internals, the job object
schema, the `#`-vs-module-function private-member rule, the two independent
`describeError` helpers, and the five error-handling rules that keep a callback failure
from ever reaching the scheduler — see [Architecture](../architecture.md). For the
extension points this design supports (job metadata, priority, stats, persistence,
one-time jobs) and the common pitfalls (time-unit confusion, singleton reuse across
tests, heap reference equality), see the [Extension Guide](../extension-guide.md).

Key properties worth stating up front, because they are easy to assume otherwise:

- **Singleton.** `new Cron()` always returns the same instance; registering a job from
  anywhere affects the one scheduler.
- **Fire-and-forget.** The scheduler reschedules a job *before* invoking its callback
  and never awaits the result. Two different jobs due on the same tick may overlap;
  the *same* job never runs concurrently with itself for the lifetime of one
  registration.
- **No timeout.** A callback whose returned promise never settles is skipped on every
  subsequent tick, forever, for that job. One ungated warning is emitted per stuck run.
  Bounding your own callback is the caller's responsibility.
- **O(log n) scheduling** via the `MinHeap` in `src/min-heap.ts`, keyed on `nextTrigger`
  (Unix seconds, not milliseconds — see Architecture § Critical Time Handling Detail).
