import { Model, hasMany } from '@stonyx/orm';

export default class DBModel extends Model {
  cronJobs = hasMany('cron-job');
  cronJobSchedules = hasMany('cron-job/schedule');
  cronJobPayloads = hasMany('cron-job/payload');
  cronJobStates = hasMany('cron-job/state');
  cronJobDeliveries = hasMany('cron-job/delivery');
  cronRuns = hasMany('cron-run');
}
