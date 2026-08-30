/**
 * Issue #34a — take the consumer callback out of the critical section.
 *
 * `executeJob` used to `await this.onJobDue(job)` — arbitrary, unbounded
 * consumer code — while `onTimer` held the module-global lock. A callback
 * that never settles therefore poisoned the lock chain permanently and
 * wedged every subsequent `locked()` call (add/update/remove).
 *
 * Separately, `run()` executed without detaching the job from the heap
 * first, so every manual run permanently duplicated the heap entry.
 *
 * House pattern per `.claude/testing.md`: sinon fake timers with
 * `shouldAdvanceTime: false`. No real timers, no sleeps. Hang probes float
 * the promise rather than awaiting it, then assert a settled-flag after
 * `clock.tickAsync(0)` — so a hung path produces a clean assertion failure
 * rather than a runner timeout.
 */
import QUnit from 'qunit';
import sinon, { type SinonFakeTimers } from 'sinon';
import { setupIntegrationTests } from 'stonyx/test-helpers';
import CronService from '../../src/service.js';
import { resetLock } from '../../src/locked.js';

const { module, test, todo } = QUnit;

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
    todo('add/update/remove all resolve while onJobDue is still in flight', function (assert) {
      assert.ok(false, 'TODO: never-settling onJobDue, job driven due via clock.tickAsync(31_000); assert service.running === true as precondition, then add/update/remove each settle');
    });
  });

  module('A6 — run() does not duplicate heap entries', function () {
    todo('run(id, force) twice leaves exactly one heap entry for the job', function (assert) {
      assert.ok(false, 'TODO: two forced runs, then heap.items.filter(i => i.key === job.id).length === 1 (currently 3)');
    });
  });

  module('A9 — a self-mutating callback is no longer reentrant', function () {
    todo('onJobDue calling add() and update() on itself completes and both mutations apply', function (assert) {
      assert.ok(false, 'TODO: inner add resolves, status().jobCount === 2, self-update applied');
    });
  });

  module('A4 — run() will not launch a concurrent second invocation', function () {
    todo('run(id, force) on a job with runningAtMs returns skipped/already running', function (assert) {
      assert.ok(false, 'TODO: assert { status: skipped, reason: already running } and that onJobDue was not re-entered');
    });
  });

  module('regression guards', function () {
    todo('the timer path still executes a due job and re-arms with a single heap entry', function (assert) {
      assert.ok(false, 'TODO: guard — phase split must not change the happy-path timer behaviour');
    });
  });
});
