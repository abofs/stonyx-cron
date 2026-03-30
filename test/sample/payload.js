/**
 * Sample cron job definitions and expected serialized shapes.
 *
 * `definitions` — raw input as an AI or consumer would provide.
 * `serialized`  — the shape persisted to the ORM store after normalization + createJob.
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

export const serialized = {
  cronJobs: [
    {
      id: 'job-1',
      name: 'Every Minute Check',
      enabled: true,
      deleteAfterRun: false,
      sessionTarget: 'isolated',
      wakeMode: 'now',
      createdAtMs: 1750003200000,
      updatedAtMs: 1750003200000,
      schedule: { id: 'job-1', kind: 'every', everyMs: 60000 },
      payload: { id: 'job-1', kind: 'agentTurn', message: 'run diagnostics' },
      state: { id: 'job-1', nextRunAtMs: 1750003260000, consecutiveErrors: 0, scheduleErrorCount: 0 },
      delivery: { id: 'job-1', mode: 'announce' },
    },
    {
      id: 'job-2',
      name: 'Nightly Cleanup',
      enabled: true,
      deleteAfterRun: false,
      sessionTarget: 'main',
      wakeMode: 'now',
      createdAtMs: 1750003200000,
      updatedAtMs: 1750003200000,
      schedule: { id: 'job-2', kind: 'cron', expr: '0 3 * * *' },
      payload: { id: 'job-2', kind: 'systemEvent', text: 'nightly cleanup cycle' },
      state: { id: 'job-2', consecutiveErrors: 0, scheduleErrorCount: 0 },
    },
  ],
  cronJobSchedules: [
    { id: 'job-1', kind: 'every', everyMs: 60000 },
    { id: 'job-2', kind: 'cron', expr: '0 3 * * *' },
  ],
  cronJobPayloads: [
    { id: 'job-1', kind: 'agentTurn', message: 'run diagnostics' },
    { id: 'job-2', kind: 'systemEvent', text: 'nightly cleanup cycle' },
  ],
  cronJobStates: [
    { id: 'job-1', nextRunAtMs: 1750003260000, consecutiveErrors: 0, scheduleErrorCount: 0 },
    { id: 'job-2', consecutiveErrors: 0, scheduleErrorCount: 0 },
  ],
  cronJobDeliveries: [
    { id: 'job-1', mode: 'announce' },
  ],
  cronRuns: [],
};
