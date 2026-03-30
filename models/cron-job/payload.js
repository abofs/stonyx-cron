import { Model, attr } from '@stonyx/orm';

export default class CronJobPayloadModel extends Model {
  kind = attr('string');
  message = attr('string');
  text = attr('string');
}
