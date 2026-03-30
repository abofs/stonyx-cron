import { Model, attr } from '@stonyx/orm';

export default class CronRunModel extends Model {
  jobId = attr('string');
  status = attr('string');
  error = attr('string');
  summary = attr('string');
  runAtMs = attr('number');
  durationMs = attr('number');
  nextRunAtMs = attr('number');
  ts = attr('number');
}
