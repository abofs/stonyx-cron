# stonyx-cron Project Structure

## Detailed Guides

- [Architecture & Core Components](./architecture.md) -- Deep dive into Cron and MinHeap classes, dependencies, code patterns, and configuration reference
- [Testing](./testing.md) -- Test structure, fake timers, spies/stubs patterns, and running tests
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
│   └── CLAUDE.md                        - Pointer to docs/index.md
├── .github/
│   └── workflows/
│       ├── ci.yml                       - CI pipeline (PR checks)
│       ├── publish.yml                  - npm publish workflow
│       └── security-audit.yml           - Daily security audit (stonyx-workflows)
├── config/
│   └── environment.js                   - Cron module configuration
├── docs/
│   ├── index.md                         - Documentation entry point
│   ├── architecture.md                  - Core components & code patterns
│   ├── deprecation-remediation.md       - npm deprecation-message remediation (#50)
│   ├── extension-guide.md               - Extension points & pitfalls
│   ├── project-structure.md             - Project overview & structure
│   ├── release.md                       - Release process
│   ├── service-design.md                - CronService internals
│   └── testing.md                       - Testing guide
├── scripts/
│   └── deprecation-remediation.sh       - Applies that remediation
├── src/
│   ├── main.ts                          - Cron class (singleton scheduler, default export)
│   ├── min-heap.ts                      - MinHeap priority queue
│   ├── service.ts                       - CronService
│   ├── job.ts, schedule.ts, cron-parser.ts, normalize.ts, run-log.ts, locked.ts
│   │                                    - CronService building blocks (each a public subpath)
│   └── types/                           - Ambient declarations for stonyx and @stonyx/utils
├── test/
│   ├── config/environment.js            - Test config overrides (see testing.md)
│   ├── integration/                     - Cron and CronService end-to-end tests
│   ├── sample/                          - Canonical job-definition samples
│   ├── unit/                            - One *-test.ts per source module
│   └── setup.ts                         - QUnit --import setup that awaits Stonyx.ready
├── stonyx-bootstrap.cjs                 - CommonJS bootstrap that loads Stonyx first
├── tsconfig.json, tsconfig.test.json
├── package.json                         - Package metadata and exports
├── README.md                            - Project documentation
├── LICENSE.md                           - Apache 2.0 license
├── .npmignore                           - Files excluded from npm publish
├── .nvmrc                               - Node version specification
└── .gitignore                           - Git ignore rules
```

---

## 4. Package Exports

`package.json` `exports` maps each public import path to `./dist/*.js`. The list of paths and what each one exports lives in one place: [README § Exports](../README.md#exports).

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
