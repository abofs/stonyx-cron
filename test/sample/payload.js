/**
 * Sample cron job definitions.
 *
 * `definitions` — raw input as an AI or consumer would provide.
 */

export const definitions = {
  // Legacy simple interval — the pattern used before advanced scheduling
  legacyBackup: {
    key: 'backup',
    interval: 3600,
    runOnInit: false,
  },

  legacyHealthCheck: {
    key: 'health-check',
    interval: 300,
    runOnInit: true,
  },

  // Advanced: recurring interval
  everyMinute: {
    name: 'Every Minute Check',
    schedule: { kind: 'every', everyMs: 60_000 },
    payload: { kind: 'agentTurn', message: 'run diagnostics' },
  },

  // Advanced: cron expression
  dailyMorning: {
    name: 'Daily Morning Report',
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' },
    payload: { kind: 'agentTurn', message: 'generate morning report' },
  },

  // Advanced: one-shot
  oneShot: {
    name: 'Reminder',
    schedule: { kind: 'at', at: '2026-07-01T12:00:00Z' },
    payload: { kind: 'agentTurn', message: 'follow up on PR' },
  },

  // Advanced: system event (targets main session)
  systemEvent: {
    name: 'Nightly Cleanup',
    schedule: { kind: 'cron', expr: '0 3 * * *' },
    payload: { kind: 'systemEvent', text: 'nightly cleanup cycle' },
  },

  // AI-style flat params (no nesting, wrong casing)
  aiFlat: {
    name: 'AI Created Job',
    schedule: { everyMs: 120000 },
    message: 'check the weather',
  },

  // Disabled job
  disabled: {
    name: 'Paused Job',
    schedule: { kind: 'every', everyMs: 300_000 },
    payload: { kind: 'agentTurn', message: 'paused task' },
    enabled: false,
  },
};
