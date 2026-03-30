import { Serializer } from '@stonyx/orm';

export default class CronRunSerializer extends Serializer {
  map = {
    jobId: 'jobId',
    status: 'status',
    error: 'error',
    summary: 'summary',
    runAtMs: 'runAtMs',
    durationMs: 'durationMs',
    nextRunAtMs: 'nextRunAtMs',
    ts: 'ts',
  }
}
