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

## Configuration

Optionally, informational logging and debugging can be controlled through `config.cron`:

```js
config.cron = {
  log: true // informational cron job logs; defaults to true
};

config.debug = true; // optional: debug logs for job registration and execution
```

`config.cron.log` gates **informational** messages only. Error reports and the
stuck-job warning described above are never gated by it, so setting it to `false`
cannot make a dropped execution silent.

## License

Apache — do what you want, just keep attribution.
