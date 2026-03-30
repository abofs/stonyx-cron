const { CRON_LOG, CRON_PERSISTENCE } = process;

export default {
  log: CRON_LOG ?? true,
  logColor: '#888',
  persistence: CRON_PERSISTENCE ?? false,
}
