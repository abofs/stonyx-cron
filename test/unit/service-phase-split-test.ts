/**
 * Issue #34 — take the consumer callback out of the critical section.
 *
 * `executeJob` awaits `this.onJobDue(job)` — arbitrary, unbounded consumer
 * code — while `onTimer` holds the module-global lock. A callback that never
 * settles therefore poisons the lock chain permanently and wedges every
 * subsequent `locked()` call (add/update/remove).
 *
 * Separately, `run()` executes without detaching the job from the heap first,
 * so every manual run permanently duplicates the heap entry.
 *
 * House pattern per `.claude/testing.md`: sinon fake timers with
 * `shouldAdvanceTime: false`. No real timers, no sleeps. Hang probes float the
 * promise rather than awaiting it, then assert a settled-flag after
 * `clock.tickAsync(0)` — so a hung path produces a clean assertion failure
 * rather than a runner timeout.
 *
 * SCAFFOLD COMMIT: every acceptance criterion below is present as a
 * `QUnit.todo` stub. Bodies land in subsequent commits.
 */
import QUnit from 'qunit';
import sinon, { type SinonFakeTimers } from 'sinon';
import { setupIntegrationTests } from 'stonyx/test-helpers';
import CronService from '../../src/service.js';
import { resetLock } from '../../src/locked.js';

const { module, todo } = QUnit;

module('CronService — phase split (#34)', function (hooks) {
  setupIntegrationTests(hooks);
  let service: CronService;
  let clock: SinonFakeTimers;

  hooks.beforeEach(function () {
    clock = sinon.useFakeTimers({ shouldAdvanceTime: false, now: new Date('2026-06-15T12:00:00Z') });
    service = new CronService();
  });

  hooks.afterEach(function () {
    service.stop();
    clock.restore();
    resetLock();
  });

  module('A3 — a hung callback holds no lock', function () {
    // AC1: with a never-settling onJobDue and a job driven due, add(), update()
    // and remove() all still resolve.
    todo('add/update/remove all resolve while onJobDue is still in flight', function (assert) {
      assert.ok(false, 'TODO: not implemented');
    });
  });

  module('A6 — run() does not duplicate heap entries', function () {
    // AC2: run(id, 'force') twice leaves exactly one heap entry for that job.
    todo('run(id, force) twice leaves exactly one heap entry for the job', function (assert) {
      assert.ok(false, 'TODO: not implemented');
    });
  });

  module('A9 — a self-mutating callback is no longer reentrant', function () {
    // AC3: an onJobDue that calls service.add() and service.update() from
    // inside itself completes, and both mutations apply.
    todo('onJobDue calling add() and update() on itself completes and both mutations apply', function (assert) {
      assert.ok(false, 'TODO: not implemented');
    });
  });

  module('A4 — run() will not launch a concurrent second invocation', function () {
    // AC4: run(id, 'force') on a job with runningAtMs set returns
    // { status: 'skipped', reason: 'already running' }.
    todo('run(id, force) on a job with runningAtMs returns skipped/already running', function (assert) {
      assert.ok(false, 'TODO: not implemented');
    });
  });

  module('claim/settle integrity — a claim always gets a settle', function () {
    // Supporting coverage for AC5: the split must not be able to strand a job
    // off the heap with runningAtMs set, on any exit path.
    todo('a throwing callback still settles, and its batch siblings still run', function (assert) {
      assert.ok(false, 'TODO: not implemented');
    });

    todo('the lock has real service-tier coverage: a yielding callback is observed in flight', function (assert) {
      assert.ok(false, 'TODO: not implemented');
    });
  });
});
