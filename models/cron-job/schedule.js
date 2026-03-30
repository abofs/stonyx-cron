import { Model, attr } from '@stonyx/orm';

export default class CronJobScheduleModel extends Model {
  kind = attr('string');
  at = attr('string');
  everyMs = attr('number');
  anchorMs = attr('number');
  expr = attr('string');
  tz = attr('string');
}
