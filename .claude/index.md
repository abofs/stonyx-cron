# stonyx-cron Project Structure

## Detailed Guides

- [Architecture & Core Components](./architecture.md) — Deep dive into Cron and MinHeap classes, dependencies, code patterns, and configuration reference
- [Testing Guidelines](./testing.md) — Test structure, fake timers, spies/stubs patterns, and running tests
- [Extension Guide](./extension-guide.md) — Extension points, common pitfalls, and future enhancement opportunities

---

## 1. Project Overview

**stonyx-cron** is a lightweight async job scheduler for the Stonyx framework that uses a min-heap priority queue for efficient job scheduling.

**Core Purpose:**
- Schedule and execute async jobs at specified intervals
- O(log n) scheduling efficiency via min-heap priority queue
- Robust error handling that never crashes the scheduler
- Configuration-driven logging aligned with Stonyx patterns

**Technology Stack:**
- **Module System:** ES Modules (ESM)
- **Testing:** QUnit with Sinon for spies/stubs/fake timers
- **Dependencies:** Stonyx framework, @stonyx/utils/date
- **Node Version:** Specified in `.nvmrc`

---

## 2. Architecture & Design Decisions

### Singleton Pattern
The `Cron` class uses a singleton pattern to ensure only one scheduler instance exists across the entire application. The constructor returns the existing instance if one has already been created.

```javascript
constructor() {
  if (Cron.instance) return Cron.instance;
  Cron.instance = this;
}
```

**Rationale:** Prevents multiple competing schedulers and ensures consistent job management.

### Min-Heap Priority Queue
Jobs are stored in a min-heap ordered by `nextTrigger` timestamp, allowing O(log n) insertion and O(1) peek of the next job to run.

**Heap Property:** Parent nodes have earlier `nextTrigger` values than their children, so the root is always the next job to execute.

### Async Job Execution Strategy
- Jobs are executed with `await job.callback()` to handle async operations
- Errors are caught and logged but never crash the scheduler
- After execution (success or failure), jobs are rescheduled and re-inserted into the heap
- The scheduler reschedules itself after processing all due jobs

### Configuration-Driven Logging
Logging follows Stonyx patterns:
- Check `config.debug` before debug logs
- Check `config.cron?.log` before cron-specific logs
- Use `log.cron()` for cron messages, `log.error()` for errors

---

## 3. File Structure

```
stonyx-cron/
├── .claude/
│   ├── index.md                          - Project overview & structure
│   ├── architecture.md                   - Core components & code patterns
│   ├── testing.md                        - Testing guidelines
│   └── extension-guide.md               - Extension points & pitfalls
├── .github/
│   └── workflows/                        - CI/CD configuration
├── config/
│   └── environment.js                    - Cron module configuration
├── src/
│   ├── main.js                           - Cron class (singleton scheduler)
│   └── min-heap.js                       - MinHeap priority queue implementation
├── test/
│   └── unit/
│       ├── cron-test.js                  - Cron class unit tests
│       └── min-heap-test.js              - MinHeap unit tests
├── package.json                          - Package metadata and exports
├── README.md                             - Project documentation
├── LICENSE.md                            - Apache 2.0 license
├── .nvmrc                                - Node version specification
└── .gitignore                            - Git ignore rules
```

---

## 10. Package Exports

**File:** `stonyx-cron/package.json`

```json
{
  "exports": {
    ".": "./src/main.js",
    "./min-heap": "./src/min-heap.js"
  }
}
```

**Usage:**
```javascript
// Import Cron class (default export)
import Cron from '@stonyx/cron';

// Import MinHeap class (for advanced usage)
import MinHeap from '@stonyx/cron/min-heap';
```

---

## 14. Related Resources

### Stonyx Framework
- Main repository: https://github.com/abofs/stonyx
- Configuration patterns: See `stonyx/config` documentation
- Logging patterns: See `stonyx/log` documentation
- Test helpers: See `stonyx/test-helpers` documentation

### Testing
- QUnit documentation: https://qunitjs.com/
- Sinon documentation: https://sinonjs.org/
- Fake timers: https://sinonjs.org/releases/latest/fake-timers/

### Data Structures
- Min-heap algorithm: https://en.wikipedia.org/wiki/Binary_heap
- Priority queue patterns: See MinHeap implementation

### Project Repository
- GitHub: https://github.com/abofs/stonyx-cron
- Issues: https://github.com/abofs/stonyx-cron/issues
- License: Apache 2.0
