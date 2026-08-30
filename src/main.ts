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

/**
 * Floor for a job interval, in whole seconds.
 *
 * `runDueJobs` no longer awaits the callback, so `next.nextTrigger > now` is the
 * drain loop's only exit condition *and* the loop has no suspension point left.
 * An interval that fails to advance `nextTrigger` therefore spins the loop
 * forever and blocks the event loop, rather than merely scheduling too often.
 */
const MIN_INTERVAL_SECONDS = 1;

interface CronJob extends HeapItem {
  callback: () => void | Promise<void>;
  interval: string;
  key: string;

  /**
   * Timestamp (ms) at which the current invocation started; `undefined` when the
   * job is idle. Mirrors `job.state.runningAtMs` in the service tier
   * (`src/job.ts` `markRunning`/`applyResult`/`isDue`).
   */
  runningAtMs?: number;
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

    this.timer = setTimeout(() => this.runDueJobs(), delay);
  }

  async runDueJobs(): Promise<void> {
    const now = getTimestamp();
    const { heap } = this;

    while (!heap.isEmpty()) {
      const next = heap.peek();
      if (!next || next.nextTrigger > now) break;
      const job = heap.pop() as CronJob;

      if (config.debug) this.log('job has been triggered', job.key);

      // Reschedule *before* invoking. The callback's result is not used by this
      // class (`runDueJobs` returns void), so awaiting it bought nothing and
      // cost the scheduler: a callback that never settled left the job absent
      // from the heap and stopped the timer from ever re-arming.
      this.setNextTrigger(job);
      heap.push(job);

      this.safeInvoke(job);
    }

    this.scheduleNextRun();
  }

  /**
   * The one safe way this class invokes a consumer callback.
   *
   * Never blocks the caller, catches synchronous throws and asynchronous
   * rejections alike, and skips the invocation entirely when the job's previous
   * invocation has not settled yet (fire-and-forget would otherwise let a slow
   * job stack invocations on itself).
   */
  safeInvoke(job: CronJob, runOnInit: boolean = false): void {
    const { key } = job;
    const context = runOnInit ? 'failed on init:' : 'failed:';

    // The in-flight guard lives on the job object, not in a module-level set
    // keyed by string. That is what gives each invocation an identity: the only
    // thing that ever clears the flag is the settle handler of the invocation
    // that set it, and that handler closes over this exact job object. A stale
    // handler therefore cannot release a *later* invocation's guard. It also
    // matches the in-repo idiom one tier up (`job.state.runningAtMs`).
    //
    // `unregister` needs no explicit clear as a result: the flag is dropped with
    // the job object, so a re-registered key gets a fresh object and runs
    // immediately, while the abandoned invocation can only ever release itself.
    if (job.runningAtMs !== undefined) {
      log.warn(`Cron job "${key}" is still running; skipping this tick`);
      return;
    }

    job.runningAtMs = Date.now();

    try {
      const result = job.callback();

      if (result && typeof (result as Promise<void>).then === 'function') {
        Promise.resolve(result)
          .catch(err => log.error(`Cron job "${key}" ${context}`, err))
          .finally(() => this.release(job));

        return;
      }

      this.release(job);
    } catch (err) {
      this.release(job);
      log.error(`Cron job "${key}" ${context}`, err);
    }
  }

  /** Release a job's in-flight guard. Only ever called for the job it belongs to. */
  release(job: CronJob): void {
    job.runningAtMs = undefined;
  }

  register(key: string, callback: () => void | Promise<void>, interval: string, runOnInit: boolean = false): void {
    const seconds = this.parseInterval(interval);

    // Fail fast rather than clamp. An unparseable interval is a programming
    // error with exactly one likely cause — a cron expression handed to the
    // legacy class, which takes whole seconds — and clamping it would silently
    // run a job intended for every 5 minutes once per second, hammering whatever
    // the callback talks to. Throwing surfaces it at the call site, at boot,
    // before anything is scheduled. A degenerate-but-parseable interval (`'0'`,
    // `'-5'`) is a different case: it is interpretable as "as often as possible"
    // and is clamped to the floor with one warning.
    if (seconds === null) {
      throw new TypeError(
        `Cron job ${JSON.stringify(key)} has an invalid interval ${JSON.stringify(interval)}: `
        + 'expected whole seconds (e.g. \'30\'). The legacy Cron class does not accept cron '
        + 'expressions — use CronService for those.',
      );
    }

    if (parseInt(interval, 10) < MIN_INTERVAL_SECONDS) {
      log.warn(
        `Cron job ${JSON.stringify(key)} interval ${JSON.stringify(interval)} is below the `
        + `${MIN_INTERVAL_SECONDS}s floor; clamping to ${MIN_INTERVAL_SECONDS}s`,
      );
    }

    const job: CronJob = { callback, interval, key, nextTrigger: 0 };
    this.jobs[key] = job;
    this.setNextTrigger(job);
    this.heap.push(job);

    if (config.debug) {
      this.log(`job has been registered with interval: ${interval}`, key);
    }

    if (runOnInit) this.safeInvoke(job, true);

    this.scheduleNextRun();
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
   * Parse a job interval (whole seconds, as a string) into a positive integer.
   *
   * Returns `null` when the value cannot be parsed at all, so callers can choose
   * between failing fast (`register`) and falling back (`setNextTrigger`).
   */
  parseInterval(interval: string): number | null {
    const seconds = parseInt(interval, 10);

    if (!Number.isFinite(seconds)) return null;

    return Math.max(MIN_INTERVAL_SECONDS, seconds);
  }

  setNextTrigger(job: CronJob): void {
    // `register` rejects an unparseable interval up front; this floor is the
    // backstop for a job object mutated after registration (`cron.jobs` is
    // public, mutable state) and is what actually guarantees the drain loop
    // terminates. Never let `nextTrigger` land on `NaN` or on `now`.
    job.nextTrigger = getTimestamp() + (this.parseInterval(job.interval) ?? MIN_INTERVAL_SECONDS);
  }

  log(text: string, key: string | null = null): void {
    if (!config.cron?.log) return;

    const tag = key ? `Cron::${key}` : `Cron`;
    log.cron(`${tag} - ${text}:`);
  }
}
