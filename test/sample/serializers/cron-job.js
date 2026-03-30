import { Serializer } from '@stonyx/orm';

export default class CronJobSerializer extends Serializer {
  map = {
    name: 'name',
    description: 'description',
    enabled: 'enabled',
    deleteAfterRun: 'deleteAfterRun',
    sessionTarget: 'sessionTarget',
    wakeMode: 'wakeMode',
    createdAtMs: 'createdAtMs',
    updatedAtMs: 'updatedAtMs',
    schedule: 'schedule',
    payload: 'payload',
    state: 'state',
    delivery: 'delivery',
  }
}
