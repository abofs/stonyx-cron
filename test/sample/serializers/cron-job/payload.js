import { Serializer } from '@stonyx/orm';

export default class CronJobPayloadSerializer extends Serializer {
  map = {
    kind: 'kind',
    message: 'message',
    text: 'text',
  }
}
