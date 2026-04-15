const { CRON_LOG } = process as unknown as Record<string, unknown>;

export default {
  log: CRON_LOG ?? true,
  logColor: '#888',
}
