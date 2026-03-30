import { Model, attr } from '@stonyx/orm';

export default class CronJobStateModel extends Model {
  nextRunAtMs = attr('number');
  runningAtMs = attr('number');
  lastRunAtMs = attr('number');
  lastStatus = attr('string');
  lastError = attr('string');
  lastDurationMs = attr('number');
  consecutiveErrors = attr('number');
  scheduleErrorCount = attr('number');
}
