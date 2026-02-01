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

> All other methods and classes (like `MinHeap`) are used internally and are not intended for direct use.

## Configuration

Optionally, logging and debugging can be enabled through `config.cron`:

```js
config.cron = {
  log: true // enable cron job logs
};

config.debug = true; // optional: debug logs for job registration and execution
```

## License

Apache — do what you want, just keep attribution.
