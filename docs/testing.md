# Testing

## Running Tests

```bash
pnpm test
```

That runs `pnpm build && NODE_ENV=test node --import tsx/esm --import ./test/setup.ts node_modules/qunit/bin/qunit.js 'test/**/*-test.ts'`. QUnit runs the `.ts` test sources directly under `tsx`; nothing is precompiled to a `dist-test/`. The `pnpm build` step matters: the package self-reference `@stonyx/cron` resolves to `dist/main.js`, so a test that imports `@stonyx/cron` exercises the built artifact rather than `src/`. `test/unit/cron-test.ts` pins that with an `import.meta.resolve('@stonyx/cron')` assertion.

## Layout

- `test/unit/`: one file per source module (`cron-test.ts`, `service-test.ts`, `cron-parser-test.ts`, `min-heap-test.ts`, ...), plus `service-phase-split-test.ts` for the CronService execution model and `publish-surface-test.ts` for the packed tarball.
- `test/integration/`: `legacy-cron-test.ts` (the default `Cron` export) and `advanced-scheduling-test.ts` (`CronService` end to end: start, add, timer fires, execute, reschedule).
- `test/sample/`: sample job payloads.
- `test/config/environment.js`: test config overrides. It sets `cron.log: false` for the whole suite, so `service.log()` is a no-op in tests. A test that needs to observe a gated log line sets `config.cron.log` itself and restores the value it captured beforehand, not a hardcoded literal. A test that depends on the flag being off pins it off itself rather than inheriting it.

  The file can be `.js` or `.ts`: with the declared `stonyx@0.2.3-beta.98`, `importConfig` tries `test/config/environment.ts`, then `.js` (measured: renaming it to `.ts` keeps `cron.log` false and the suite green). An earlier note said it must stay `.js`; that held only for the stonyx releases whose loader looked for `.js` alone (abofs/stonyx#105), and it is no longer true. What does matter is that the file exists. If it is deleted, the override is skipped without an error and `cron.log` falls back to `true` from `config/environment.js`. `test/unit/cron-test.ts` ("test config override") catches that by reading `config.cron.log` at module load, before any test changes it. Renaming the file to an extension the loader does not resolve, such as `.mjs`, fails the boot with `Config present but not loadable`.

## Test Structure

Tests use QUnit modules with `setupIntegrationTests` from `stonyx/test-helpers`:

```ts
import QUnit from 'qunit';
import sinon, { type SinonFakeTimers } from 'sinon';
import Cron from '@stonyx/cron';
import { setupIntegrationTests } from 'stonyx/test-helpers';

const { module, test } = QUnit;

module('[Unit] Cron', function (hooks) {
  setupIntegrationTests(hooks);

  let cron: Cron;
  let clock: SinonFakeTimers;

  hooks.beforeEach(function () {
    clock = sinon.useFakeTimers({ shouldAdvanceTime: false });
    cron = new Cron();
  });

  hooks.afterEach(function () {
    sinon.restore();
  });

  test('test description', async function (assert) {
    // Test implementation
  });
});
```

`Cron` is a singleton. Tests that need a fresh instance set `Cron.instance = null` before constructing one. `CronService` is not a singleton, so each test can create its own.

## Fake Timers

Use fake timers for every time-based test:

```ts
// beforeEach
clock = sinon.useFakeTimers({ shouldAdvanceTime: false });

// Advance time synchronously
clock.tick(5000);

// Then let async callbacks run
await clock.tickAsync(0);

// afterEach
sinon.restore();
```

`shouldAdvanceTime: false` keeps real time from leaking into fake time, so tests are deterministic.

## Spies and Stubs

```ts
// Spy on a callback
const cb = sinon.spy();
cron.register('job1', cb, 5);
assert.ok(cb.calledOnce, 'Callback executed once');

// Stub a failing callback
const stub = sinon.stub().rejects(new Error('boom'));
cron.register('jobErr', stub, 1);

// Spy on an existing method
const logSpy = sinon.spy(log, 'cron');
```

## Testing the Scheduler

Each rule below comes from a test that once passed against broken code.

- **Drive the scheduler through the clock, never by calling `onTimer()` directly.** Calling `onTimer()` without advancing the fake clock makes `findDueJobs` return `[]`, so `onJobDue` never runs and the test passes vacuously. Advance with `await clock.tickAsync(...)` past `nextRunAtMs` so `armTimer` fires `onTimer` naturally. Also assert that a callback really is in flight (`service.running === true`, or `job.state.runningAtMs` set).
- **Give `onJobDue` a callback that really yields.** A synchronous `onJobDue` never enters the lock's critical section, so a lock-ordering bug stays invisible. Use a hand-resolved deferred (`new Promise(r => { resolve = r; })`), or a never-settling promise for hang probes.
- **Match a stub's sync/async shape to the real implementation.** `log.error` is an async method, so its real failures are rejections. A stub that throws synchronously cannot reproduce them, and an assertion built on it cannot fail. Stub with the right shape, then mutate the code once to prove the assertion can go red.
- **Never await a possibly-hung path from the test body.** Float the promise and assert a settled flag after `clock.tickAsync(0)`. A hung path then fails an assertion instead of timing out the runner.
- **Sample at the right moment.** `findDueJobs` pops heap entries and silently discards any whose job is not due, so the scheduler heals a duplicate heap entry on the next timer pass. An assertion placed after a trailing `tickAsync` measures the healed state. Sample at settle time, or go through `run()` (which arms a timer but never fires one) and assert with no trailing tick.
- **Scope heap assertions to a key:** `heap.items.filter(i => i.key === job.id).length`, never `items.length`.
- **Call `resetLock()` (from `src/locked.ts`, published as `@stonyx/cron/locked`) in `afterEach`.** The lock is module-global, so one poisoned chain cascades into every later test.
- **Label assertions by what they prove.** `test/unit/service-phase-split-test.ts` uses `precondition:` for facts that also hold on the unfixed code, `reached:` for checks that the fixed path actually ran, and `guard:` for assertions that pass both before and after a fix.

## Coverage

Tests should cover:

- Job registration and execution
- Rescheduling behaviour
- Unregistration
- Error handling and backoff
- Configuration-driven logging
- Edge cases (empty heap, multiple jobs, and so on)

The pure functions (`computeNextRunAtMs`, `validateSchedule`, `parseCronExpression`, `nextOccurrence`, `errorBackoffMs`, `isDue`, `createJob`, `normalizeJobInput`) can be tested without any service setup.
