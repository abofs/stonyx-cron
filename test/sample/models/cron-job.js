import { Model, attr, belongsTo } from '@stonyx/orm';

export default class CronJobModel extends Model {
  name = attr('string');
  description = attr('string');
  enabled = attr('boolean');
  deleteAfterRun = attr('boolean');
  sessionTarget = attr('string');
  wakeMode = attr('string');
  createdAtMs = attr('number');
  updatedAtMs = attr('number');

  schedule = belongsTo('cron-job/schedule');
  payload = belongsTo('cron-job/payload');
  state = belongsTo('cron-job/state');
  delivery = belongsTo('cron-job/delivery');
}
