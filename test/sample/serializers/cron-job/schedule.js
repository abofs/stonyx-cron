import { Serializer } from '@stonyx/orm';

export default class CronJobScheduleSerializer extends Serializer {
  map = {
    kind: 'kind',
    at: 'at',
    everyMs: 'everyMs',
    anchorMs: 'anchorMs',
    expr: 'expr',
    tz: 'tz',
  }
}
