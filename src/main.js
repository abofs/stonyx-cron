import config from 'stonyx/config';
import log from 'stonyx/log';
import { getTimestamp } from "@stonyx/utils/date";
import MinHeap from '@stonyx/cron/min-heap';

export default class Cron {
  jobs = {};
  heap = new MinHeap();
  timer = null;

  constructor() {
    if (Cron.instance) return Cron.instance;
    Cron.instance = this;
  }

  scheduleNextRun() {
    clearTimeout(this.timer);

    const { heap } = this;

    if (heap.isEmpty()) return;

    const nextJob = heap.peek();
    const delay = Math.max(0, nextJob.nextTrigger - getTimestamp()) * 1000;

    this.timer = setTimeout(() => this.runDueJobs(), delay);
  }

  async runDueJobs() {
    const now = getTimestamp();
    const { heap } = this;

    while (!heap.isEmpty() && heap.peek().nextTrigger <= now) {
      const job = heap.pop();

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

  register(key, callback, interval, runOnInit=false) {
    const job = { callback, interval, key };
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

  unregister(key) {
    const { heap, jobs } = this;
    const job = jobs[key];
    
    if (!job) return;

    delete jobs[key];
    heap.remove(job);

    if (config.debug) this.log('job has been unregistered', key);

    this.scheduleNextRun();
  }

  setNextTrigger(job) {
    job.nextTrigger = getTimestamp() + parseInt(job.interval, 10);
  }

  log(text, key = null) {
    if (!config.cron?.log) return;
    
    const tag = key ? `Cron::${key}` : `Cron`;
    log.cron(`${tag} - ${text}:`);
  }
}
