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

interface CronJob extends HeapItem {
  callback: () => void | Promise<void>;
  interval: string;
  key: string;
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

      try {
        await job.callback();
      } catch (err) {
        log.error(`Cron job "${job.key}" failed:`, err);
      }

      this.setNextTrigger(job);
      heap.push(job);
    }

    this.scheduleNextRun();
  }

  register(key: string, callback: () => void | Promise<void>, interval: string, runOnInit: boolean = false): void {
    const job: CronJob = { callback, interval, key, nextTrigger: 0 };
    this.jobs[key] = job;
    this.setNextTrigger(job);
    this.heap.push(job);

    if (config.debug) {
      this.log(`job has been registered with interval: ${interval}`, key);
    }

    if (runOnInit) {
      try {
        callback();
      } catch (err) {
        log.error(`Cron job "${key}" failed on init:`, err);
      }
    }

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

  setNextTrigger(job: CronJob): void {
    job.nextTrigger = getTimestamp() + parseInt(job.interval, 10);
  }

  log(text: string, key: string | null = null): void {
    if (!config.cron?.log) return;

    const tag = key ? `Cron::${key}` : `Cron`;
    log.cron(`${tag} - ${text}:`);
  }
}
