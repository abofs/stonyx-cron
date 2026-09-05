[![CI](https://github.com/abofs/stonyx-cron/actions/workflows/ci.yml/badge.svg)](https://github.com/abofs/stonyx-cron/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@stonyx/cron.svg)](https://www.npmjs.com/package/@stonyx/cron)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

# stonyx-cron

A small, lightweight cron/job scheduling utility for asynchronous jobs. Designed to schedule, run, and automatically re-schedule jobs at precise intervals with optional debug logging.

## Usage

```js
import Cron from '@stonyx/cron';

const cron = new Cron();

// Register a job to run every 5 seconds
cron.register('exampleJob', async () => {
  console.log('Job executed!');
}, 5, true);

// Unregister the job when no longer needed
// cron.unregister('exampleJob');
```

## How it works

`stonyx-cron` uses a min-heap internally to efficiently track the next job to run. Each job has a scheduled trigger time, and the heap ensures the job with the earliest trigger is always at the top.

When a job is executed, its next trigger time is updated, and it is re-inserted into the heap. This allows `Cron` to always know which job should run next without scanning all jobs, keeping scheduling efficient even with many jobs.

## Public Methods

|    Method    |                                Parameters                                | Description                                                                                                              |
| :----------: | :----------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------- |
|  `register`  | `key: string, callback: Function, interval: number, runOnInit?: boolean` | Register a new job with a given interval in seconds. If `runOnInit` is true, the job runs immediately upon registration. |
| `unregister` |                               `key: string`                              | Remove a previously registered job.                                                                                      |

> **Callback semantics.** Callbacks are invoked fire-and-forget: `Cron` never waits for one to settle, and reschedules a job *before* invoking it. Two *different* jobs that fall due on the same tick may therefore overlap.
>
> A job that is still running when it next falls due is skipped — and **keeps** being skipped until that invocation settles. `Cron` provides no timeout by design, so **bounding your own callback is your responsibility**: a promise that never settles means that job never runs again for the lifetime of the process, even though the scheduler stays healthy and the job stays visible in `jobs` and in the heap. Other jobs are unaffected.
>
> One warning is emitted per stuck run (not per tick), including how long the invocation has been running. That warning goes to `log.warn` and is **not** gated by `config.cron.log` — a dropped execution reported on a channel a config flag can silence would be indistinguishable from a healthy scheduler.
>
> The same-job guarantee holds for the lifetime of a **registration**, not of a key: `unregister` followed by `register` on a key whose invocation is still in flight builds a fresh job object with a fresh guard, so the replacement can run alongside the abandoned invocation. That is also the only way to recover a permanently stuck job.
>
> Synchronous throws and asynchronous rejections are both caught and reported through `log.error`, with the error's stack interpolated into the message. Neither can stop the scheduler. Note that a rejection which previously escaped `register()` as an unhandled rejection — process-fatal under Node's default — is now swallowed into `log.error`.

> `MinHeap` is also exported as a public subpath (`@stonyx/cron/min-heap`) and can be imported directly for advanced usage.

## CronService

The default export above is `Cron`: a fire-and-forget interval registry. `@stonyx/cron/service` is a separate, heavier class for jobs that need CRUD, persistence, a run log and error backoff. It is not a drop-in replacement and the two do not share a scheduler.

The two classes agree on the guarantee — the same job is never run concurrently with itself, and different jobs may overlap — but not on the mechanism or on what you can observe. `Cron` invokes callbacks fire-and-forget and reports a skipped run only as an ungated `log.warn` line, one per stuck run, never as a value. `CronService` **awaits** `onJobDue`, its return value shapes `status`/`error`/`summary`, and a refused run comes back to the caller as a value that no log setting can suppress — it is not logged. The two therefore agree on one more thing than the contrast suggests: neither can have a *refused* run made silent by `config.cron.log` — `Cron`'s skip warning is ungated, and `CronService`'s refusal is a return value rather than a log line. A job *failure* is the opposite case, and there the two classes genuinely diverge; see [Configuration](#configuration).

```js
import CronService from '@stonyx/cron/service';

const service = new CronService();
service.onJobDue = async (job) => ({ status: 'ok', summary: 'done' });

await service.start();
const job = await service.add({ name: 'Nightly', schedule: { kind: 'every', everyMs: 86_400_000 }, payload: { kind: 'agentTurn', message: 'go' } });

const result = await service.run(job.id, 'force');
```

### The `run()` contract

`run(id, mode)` resolves with an `ExecuteResult`. It **never** invokes the callback twice for one job, and it will refuse rather than queue:

| `status`    | `reason`            | Meaning                                                                        |
| :---------- | :------------------ | :----------------------------------------------------------------------------- |
| `'ok'`      | —                   | The callback resolved. `summary` and `durationMs` are set.                     |
| `'error'`   | —                   | The callback threw or rejected. `error` carries the message; backoff is applied. |
| `'skipped'` | `'not due'`         | `mode` was `'due'` and the job's next run time has not arrived. Use `'force'` to run anyway. |
| `'skipped'` | `'already running'`  | A previous invocation of **this** job has not settled. The call is refused, not queued, and nothing is logged. |
| `'skipped'` | `'removed'`         | The job was removed between the lookup and the claim. The callback did not fire. |

`run()` throws (rather than returning a result) when `id` is not a registered job: `Error: Job not found: <id>`.

**Concurrency.** A job is bounded to one in-flight invocation on every path — manual `run()` and the timer both claim it first. **Different** jobs are not bounded: the callback is deliberately invoked outside the internal lock, so N concurrent `run()` calls on N distinct jobs produce N concurrent callbacks. The scheduler itself never generates that fan-out (its timer path invokes a due batch sequentially); only a caller can. If you drive `run()` from a request handler, bound it on your side. Taking the callback out of the lock is what stops a callback that never settles from blocking `add`/`update`/`remove`; restoring the bound by putting it back would restore that deadlock.

**The residual, stated plainly.** Taking the callback out of the lock fixes
`add`/`update`/`remove`; it does **not** bound the callback. A callback that
never settles still holds its job's claim forever, and because the timer's
re-entrancy latch is only released when the batch settles, it also **stops the
timer loop for every other job** — silently, with `status()` still reporting
`started: true`. There is no execution timeout by design, so bounding your own
callback is your responsibility, exactly as it is for `Cron`. Only a real
process restart recovers it: `start()` releases a claim whose owner is provably
gone, but an object still held in this process is deliberately left alone.
Tracked as #35.

### Breaking changes in this line

Five consumer-visible changes landed with the phase split (#34). Only the first
two are visible in the emitted `dist/service.d.ts`; the rest are runtime
behaviour and a type-checker will not find them for you. The measured
`dist/service.d.ts` delta against the previous release is exactly three things:
the class gained `#private;`, `reason` narrowed, and six type declarations
gained `export`. `dist/main.d.ts` is unchanged.

1. **`ExecuteResult.reason` narrowed** from `string` to `'not due' | 'already running' | 'removed'`, and gained the `'removed'` member. Comparing it against a literal outside the union, or `switch`ing on one, is now a compile error (`TS2367` / `TS2678`). Assigning it into `string | undefined` and spreading it are unaffected. The type is exported as `SkipReason`.
2. **`CronService` is nominally typed.** It carries ECMAScript hard-private members, so the declarations emit `#private;` and a structurally hand-built test double no longer assigns to `CronService` (`TS2741: Property '#private' is missing`). The break is one-directional: `class X extends CronService` still compiles, and assigning a real `CronService` to your own hand-written interface still compiles. **Migration:** declare your own interface and depend on that instead of a `CronService`-typed mock.
3. **`claimJob`, `settleJob` and `executeClaimed` are not published.** Not a change against the previous release — these members did not exist there at all. Listed because they are new internals that look like API and are deliberately unreachable: a claim taken without its matching settle strands the job permanently in-process. Guarded by `test/unit/publish-surface-test.ts`.
4. **`run()` no longer serializes across jobs** — a runtime change, not a d.ts one. See the concurrency note above.
5. **`start()` now throws on a row it cannot use.** A `Job` whose `state` is missing or frozen — `structuredClone` + `Object.freeze` is an ordinary defensive rehydration — makes `start()` reject where the previous release resolved and carried on. Measured: previous release resolves and leaves the stale claim in place; this line throws `TypeError: Cannot assign to read only property 'runningAtMs'`. The timer is still armed for the rows loaded before the throw, so this surfaces at your `await` instead of as an unhandled rejection from inside a timer callback later. **Migration:** if your store hands back frozen rows, thaw `state` before passing them, or catch at the `start()` call site.

`SkipReason`, `ExecuteResult`, `JobDueResult`, `ServiceStatus`, `ListOptions` and `OnJobDueCallback` are all exported from `@stonyx/cron/service`, so an exhaustive handler over `reason` is expressible.

## Configuration

Optionally, informational logging and debugging can be controlled through `config.cron`:

```js
config.cron = {
  log: true // informational cron job logs; defaults to true
};

config.debug = true; // optional: debug logs for job registration and execution
```

`config.cron.log` gates the `log.cron` channel only. **The two classes route job
failures differently, so what `log: false` costs you depends on which one you are
running.** Measured on this build, with a callback that throws:

| | Failure channel | Records with `log: false` |
| :--- | :--- | :--- |
| `Cron` (default export) | ungated `log.error` | emitted — unchanged |
| `CronService` | **gated** `log.cron` | **none** |

- **`Cron`** reports a callback's throw or rejection through `log.error`, and the
  stuck-job warning described above through `log.warn`. Neither is gated, so
  setting `log` to `false` cannot make a dropped or failed execution silent.
- **`CronService`** reports a job whose `onJobDue` callback throws through the
  **gated** channel, so `log: false` yields **zero** log records for that
  failure. It stays observable as `ExecuteResult.error` and as a run-log row —
  but a job driven off the timer rather than `run()` has no caller to read that
  return value, so the failure is visible only in the run log. Only the timer
  path's *unexpected* internal throw (a fault in the scheduler itself, not in
  your callback) is reported on the ungated `log.error` channel.

If you set `log: false` in production and rely on `CronService`, read failures
from the run log or from `ExecuteResult`, not from the log file.

## License

Apache — do what you want, just keep attribution.
