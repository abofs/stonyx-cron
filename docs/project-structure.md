# stonyx-cron Project Structure

## Detailed Guides

- [Architecture & Core Components](./architecture.md) -- Deep dive into Cron and MinHeap classes, dependencies, code patterns, and configuration reference
- [Testing Guidelines](../.claude/testing.md) -- Test structure, fake timers, spies/stubs patterns, and running tests
- [Extension Guide](./extension-guide.md) -- Extension points, common pitfalls, and future enhancement opportunities

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

See [architecture.md](./architecture.md) for full details on the Cron and MinHeap classes, singleton pattern, async job execution, configuration-driven logging, and time handling.

---

## 3. File Structure

```
stonyx-cron/
├── .claude/
│   ├── CLAUDE.md                        - Agent entry point
│   └── testing.md                       - Testing guidelines
├── docs/
│   ├── index.md                         - Documentation entry point
│   ├── architecture.md                  - Core components & code patterns
│   ├── extension-guide.md              - Extension points & pitfalls
│   ├── improvements.md                 - Known improvement opportunities
│   ├── project-structure.md             - Project overview & structure
│   └── release.md                       - Release process
├── .github/
│   └── workflows/
│       ├── ci.yml                       - CI pipeline (PR checks)
│       └── publish.yml                  - NPM publish workflow
├── config/
│   └── environment.js                   - Cron module configuration
├── src/
│   ├── main.js                          - Cron class (singleton scheduler)
│   └── min-heap.js                      - MinHeap priority queue implementation
├── test/
│   └── unit/
│       ├── cron-test.js                 - Cron class unit tests
│       └── min-heap-test.js             - MinHeap unit tests
├── package.json                         - Package metadata and exports
├── README.md                            - Project documentation
├── LICENSE.md                           - Apache 2.0 license
├── .npmignore                           - Files excluded from npm publish
├── .nvmrc                               - Node version specification
└── .gitignore                           - Git ignore rules
```

---

## 4. Package Exports

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

## 5. Related Resources

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
