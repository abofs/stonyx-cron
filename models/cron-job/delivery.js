import { Model, attr } from '@stonyx/orm';

export default class CronJobDeliveryModel extends Model {
  mode = attr('string');
}
