/*
 * Copyright 2025 Stone Costa
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import config from 'stonyx/config';
import log from 'stonyx/log';
import { getTimestamp } from '@stonyx/utils/date';
import MinHeap, { type HeapItem } from './min-heap.js';

/** Longest error text that may reach a log line. Anything past this is truncated. */
const MAX_LOGGED_ERROR_LENGTH = 512;

/**
 * Flatten a value for interpolation into a single log line.
 *
 * `@stonyx/logs` writes `${timestamp} ${content}\n` to a newline-delimited
 * file, so any `\r` or `\n` inside `content` ends the record early and
 * everything after it is read back as a separate entry — including a forged
 * `[timestamp] ...` prefix that is indistinguishable from a real one. Newlines
 * become the literal two characters so the content survives for a reader, and
 * the length cap keeps one pathological value from swamping the file.
 *
 * DIVERGED from the `forLog` in `src/service.ts`, deliberately — this copy is
 * NOT byte-identical to it and must not be folded into it by assuming it is.
 * (An earlier version of this docblock claimed byte-identity; #34's `fac09cb`
 * falsified that, and the two bodies now measure unequal.) `service.ts`'s is
 * TOTAL: it wraps the coercion in `String(value)` and a `try`, returning
 * `'<unrenderable value>'` rather than throwing. This one is not.
 *
 * The divergence is correct on the merits, and the reason is the call site, not
 * the helper. Both of this copy's callers are the two `forLog(...)` calls in
 * `describeError` directly below (`:82`, `:85`), and both are INSIDE that
 * function's own `try`, so a `TypeError` from `value.replace` on a
 * non-string degrades to `'<thrown value could not be rendered>'` and the log
 * record is still produced. `service.ts`'s callers are not so contained: `:700`
 * sits in a bare `catch` with nothing above it, and `:579`'s enclosing `catch`
 * has nothing left to report to — so a throw there destroyed the failure
 * record outright (measured: 0 records for a job that failed). That is why
 * totality was a live defect there and is not one here.
 *
 * Duplicated rather than shared because the two landed on separate branches.
 * The fold is still wanted, but whoever performs it MUST adopt `service.ts`'s
 * total version as the survivor: folding to this one would silently revert
 * `fac09cb`. See #66, which carries the consolidation.
 */
function forLog(value: string, maxLength: number): string {
  const flattened = value.replace(/\r\n|[\r\n\u2028\u2029]/g, '\\n');

  return flattened.length > maxLength ? `${flattened.slice(0, maxLength)}...` : flattened;
}

/**
 * Render an unknown thrown value as log text. Total by construction.
 *
 * `@stonyx/logs` reads a second argument as `logToFile`, not as a format
 * argument, so `log.error(message, err)` discards the error entirely *and*
 * forces a disk write on every failure. The error has to be interpolated into
 * the message instead — the shape `CronService.executeJob` already uses.
 *
 * Every read below touches a consumer-controlled value and can therefore throw:
 * `instanceof` runs a proxy's `getPrototypeOf` trap, `stack`/`name`/`message`
 * can be accessor properties, and `String(Object.create(null))` throws outright.
 * This function runs *inside* `invokeJob`'s catch — the one place whose job is
 * to stop a callback failure from reaching the scheduler — so a throw here
 * escapes that catch and skips `scheduleNextRun()`, which is defect #36.
 */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) {
      return forLog(err.stack ?? `${err.name}: ${err.message}`, MAX_LOGGED_ERROR_LENGTH);
    }

    return forLog(String(err), MAX_LOGGED_ERROR_LENGTH);
  } catch {
    // Deliberately not re-entrant: describing the failure to describe the error
    // would be the same read that just threw.
    return '<thrown value could not be rendered>';
  }
}

/**
 * Render a consumer-supplied job key safely for log output.
 *
 * Keys reach the log verbatim, so a key containing a newline can forge a
 * complete, well-formed log line (`'a:\n[FORGED] Cron::admin - all jobs
 * healthy'`). `JSON.stringify` quotes the value and escapes the control
 * characters, which is also how the key is rendered one tier up.
 */
function describeKey(key: string): string {
  return JSON.stringify(key);
}

interface CronJob extends HeapItem {
  callback: () => void | Promise<void>;
  interval: string;
  key: string;

  /**
   * Timestamp (ms) at which the current invocation started; `undefined` when the
   * job is idle. Optional so the emitted `CronJob` stays assignable from a job
   * object built by a consumer — `jobs`, `heap` and `setNextTrigger` all expose
   * this interface structurally, so a required field is a breaking type change.
   *
   * A timestamp rather than a boolean, mirroring `job.state.runningAtMs` in the
   * service tier (`markRunning` / `applyResult` / `isDue` in `src/job.ts`), and
   * carrying the one fact a stuck-job warning needs: how long it has been stuck.
   * `CronService.running` is a class-level re-entrancy flag and a different
   * concept; reusing that word here would collide.
   */
  runningAtMs?: number;

  /**
   * True once a skip has been reported for the *current* invocation. Bounds the
   * still-running warning to one line per stuck run instead of one per tick.
   */
  skipReported?: boolean;
}

export default class Cron {
  static instance: Cron | null;

  jobs: Record<string, CronJob> = {};
  heap: MinHeap<CronJob> = new MinHeap();
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (Cron.instance) return Cron.instance;
    Cron.instance = this;
  }

  async init(): Promise<void> {
    // Self-register so log.cron works even when @stonyx/cron is in the
    // consumer's `dependencies` (stonyx loader only merges devDependencies).
    const { logColor = '#888', logMethod = 'cron' } = config.cron ?? {};
    log.defineType(logMethod, logColor);
  }

  scheduleNextRun(): void {
    if (this.timer) clearTimeout(this.timer);

    const { heap } = this;

    if (heap.isEmpty()) return;

    const nextJob = heap.peek();
    if (!nextJob) return;
    const delay = Math.max(0, nextJob.nextTrigger - getTimestamp()) * 1000;

    // Terminal catch: `runDueJobs` is async, so anything that escapes it would
    // otherwise become an unhandled rejection raised from a bare timer callback
    // — the very failure mode this class was fixed for.
    this.timer = setTimeout(() => {
      this.runDueJobs().catch((err: unknown) => {
        this.report('error', `Cron scheduler tick failed: ${describeError(err)}`);
      });
    }, delay);
  }

  async runDueJobs(): Promise<void> {
    const now = getTimestamp();
    const { heap } = this;

    // `finally`, not a trailing statement: `scheduleNextRun()` running on every
    // exit from the drain loop is the invariant this whole fix is about. If
    // anything in the loop body ever throws, the scheduler must still re-arm
    // rather than stopping silently while `timer` still holds a fired handle.
    try {
      while (!heap.isEmpty()) {
        const next = heap.peek();
        if (!next || next.nextTrigger > now) break;
        const job = heap.pop() as CronJob;

        if (config.debug) this.log('job has been triggered', job.key);

        // Reschedule before invoking: a consumer callback is never awaited here,
        // so a callback that hangs or rejects can no longer starve the drain loop
        // or leave the job orphaned outside the heap.
        this.setNextTrigger(job);
        heap.push(job);

        this.invokeJob(job);
      }
    } finally {
      this.scheduleNextRun();
    }
  }

  register(key: string, callback: () => void | Promise<void>, interval: string, runOnInit: boolean = false): void {
    const job: CronJob = { callback, interval, key, nextTrigger: 0 };
    this.jobs[key] = job;
    this.setNextTrigger(job);
    this.heap.push(job);

    if (config.debug) {
      this.log(`job has been registered with interval: ${interval}`, key);
    }

    // `finally`, not a trailing statement, for the same reason as `runDueJobs`:
    // a job that is registered but never scheduled is defect #36's terminal
    // state reached through the other entry point. `invokeJob` is total, so
    // this guard should be unreachable — which is exactly why it is a guard and
    // not an assumption.
    try {
      if (runOnInit) this.invokeJob(job, true);
    } finally {
      this.scheduleNextRun();
    }
  }

  unregister(key: string): void {
    const { heap, jobs } = this;
    const job = jobs[key];

    if (!job) return;

    delete jobs[key];
    heap.remove(job);

    if (config.debug) this.log('job has been unregistered', key);

    this.scheduleNextRun();
  }

  /**
   * The one place this class invokes a consumer callback.
   *
   * Never blocks the caller, catches synchronous throws and asynchronous
   * rejections identically, and skips the invocation entirely while the job's
   * previous invocation has not settled (fire-and-forget would otherwise let a
   * slow job stack invocations on itself).
   *
   * Everything that touches the callback — including the thenable probe and the
   * handler attachment — is inside the `try`. A callback may return an object
   * whose `then` is a throwing getter, and reading it outside the guard would
   * abort the drain loop before `scheduleNextRun()`, which is defect #36 again.
   */
  invokeJob(job: CronJob, runOnInit: boolean = false): void {
    const { key } = job;
    const context = runOnInit ? 'failed on init:' : 'failed:';

    // The in-flight guard lives on the job object, not in a module-level set
    // keyed by string. Object identity is invocation identity: the only thing
    // that clears the guard is the settle handler of the invocation that set it,
    // and that handler closes over this exact job object, so a stale handler can
    // never release a later invocation's guard.
    if (job.runningAtMs !== undefined) {
      // Bounded to one line per stuck run, not one per tick. A permanently hung
      // job is re-pushed and re-skipped every interval forever; at the 1s
      // interval this class's own tests use that measures 43,200 lines/day per
      // job — a disk-fill and ingest-cost vector whose natural operator response
      // is to silence the only signal that the job is dead.
      if (!job.skipReported) {
        job.skipReported = true;

        const runningForSeconds = Math.max(0, Math.round((Date.now() - job.runningAtMs) / 1000));

        // Ungated, deliberately, matching the sibling `CronService` handler. A
        // skipped run is a *lost* execution, and `runDueJobs`/`register` both
        // return `void`, so this is the legacy class's only wedged-job channel.
        // Routing it through `this.log` would put it behind `config.cron.log`,
        // where a permanently dead job is indistinguishable from a healthy one.
        this.report(
          'warn',
          `Cron job ${describeKey(key)} is still running after ${runningForSeconds}s; skipping this `
          + 'tick and any further ticks until it settles (this warning is not repeated for this run)',
        );
      }

      return;
    }

    job.runningAtMs = Date.now();
    job.skipReported = false;

    try {
      const result = job.callback();

      if (result && typeof (result as Promise<void>).then === 'function') {
        Promise.resolve(result)
          .catch((err: unknown) => {
            // Braces matter: returning `report`'s value would put it back into
            // the chain, and `.finally` passes a rejection straight through.
            this.report('error', `Cron job ${describeKey(key)} ${context} ${describeError(err)}`);
          })
          .finally(() => { this.release(job); })
          // Backstop: a throw inside the error handler or the release must not
          // re-create the unhandled rejection this helper exists to prevent.
          .catch(() => {});

        return;
      }

      this.release(job);
    } catch (err: unknown) {
      this.release(job);
      this.report('error', `Cron job ${describeKey(key)} ${context} ${describeError(err)}`);
    }
  }

  /**
   * Report a scheduler-level message without ever letting the logger's own
   * failure reach the caller.
   *
   * `@stonyx/logs` convenience methods return a promise and write to disk
   * through an unguarded `mkdirSync` + `fsp.appendFile`. On a read-only or full
   * log volume that promise rejects; an unobserved rejection raised from inside
   * the handler that exists to prevent unhandled rejections would re-create
   * exactly the defect this class was fixed for.
   */
  report(level: 'error' | 'warn', message: string): void {
    try {
      const result = level === 'error' ? log.error(message) : log.warn(message);

      void Promise.resolve(result).catch(() => {});
    } catch {
      // Nowhere left to report to; the logger must never stop the scheduler.
    }
  }

  /** Release a job's in-flight guard. Only ever called for the job it belongs to. */
  release(job: CronJob): void {
    job.runningAtMs = undefined;
    job.skipReported = false;
  }

  setNextTrigger(job: CronJob): void {
    job.nextTrigger = getTimestamp() + parseInt(job.interval, 10);
  }

  log(text: string, key: string | null = null): void {
    if (!config.cron?.log) return;

    // The key is consumer-controlled and reaches the log verbatim. Strip the
    // line terminators so a key cannot forge a second, well-formed log line;
    // the surrounding format is unchanged.
    const tag = key ? `Cron::${key.replace(/[\r\n]+/g, ' ')}` : `Cron`;
    log.cron(`${tag} - ${text}:`);
  }
}
