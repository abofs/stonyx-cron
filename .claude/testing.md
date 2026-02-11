# Testing Guidelines

## Testing Guidelines

### Test Structure
Tests are located in `stonyx-cron/test/unit/` and use QUnit modules:

```javascript
import QUnit from 'qunit';
import sinon from 'sinon';
import { setupIntegrationTests } from "stonyx/test-helpers";

const { module, test } = QUnit;

module('[Unit] Cron', function (hooks) {
  setupIntegrationTests(hooks);

  let cron, clock;

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

### Fake Timers Pattern (CRITICAL)
**Always use fake timers for time-based tests:**

```javascript
// Setup in beforeEach
clock = sinon.useFakeTimers({ shouldAdvanceTime: false });

// Advance time synchronously
clock.tick(5000);  // Advance 5 seconds

// For async operations, use tickAsync
clock.tick(5000);
await clock.tickAsync(0);  // Process async callbacks

// Cleanup in afterEach
sinon.restore();
```

**Why `shouldAdvanceTime: false`?**
Prevents real time from interfering with fake time, ensuring deterministic tests.

### Spies & Stubs Patterns
```javascript
// Spy on function calls
const cb = sinon.spy();
cron.register('job1', cb, 5);
assert.ok(cb.calledOnce, 'Callback executed once');

// Stub methods
const stub = sinon.stub().rejects(new Error('boom'));
cron.register('jobErr', stub, 1);

// Spy on existing methods
const logSpy = sinon.spy(log, 'cron');
cron.log('test message');
assert.ok(logSpy.calledOnce, 'Log called');
```

### Test Coverage Expectations
Tests should cover:
- Job registration and execution
- Rescheduling behavior
- Unregistration
- Error handling
- Configuration-driven logging
- Edge cases (empty heap, multiple jobs, etc.)

### Running Tests
```bash
pnpm test  # Runs: stonyx test
```
