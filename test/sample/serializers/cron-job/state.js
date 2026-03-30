import { Serializer } from '@stonyx/orm';

export default class CronJobStateSerializer extends Serializer {
  map = {
    nextRunAtMs: 'nextRunAtMs',
    runningAtMs: 'runningAtMs',
    lastRunAtMs: 'lastRunAtMs',
    lastStatus: 'lastStatus',
    lastError: 'lastError',
    lastDurationMs: 'lastDurationMs',
    consecutiveErrors: 'consecutiveErrors',
    scheduleErrorCount: 'scheduleErrorCount',
  }
}
