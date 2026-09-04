# @stonyx/cron Documentation

`@stonyx/cron` is the Stonyx framework module for scheduled task execution using a min-heap based scheduler.

> **Two schedulers.** The default export `Cron` (`src/main.ts`) is a fire-and-forget interval registry and is what these guides describe. `CronService` (`src/service.ts`, published as `@stonyx/cron/service`) is a separate, heavier class with CRUD, a run log, error backoff and a three-phase locked execution model. Its consumer contract — the `run()` result table, the concurrency guarantee and the breaking changes in this line — is in [`README.md`](../README.md#cronservice); its design notes are in [`docs/agents/architect.md`](agents/architect.md).

## Guides

- [Architecture](architecture.md) -- Core components deep dive: Cron and MinHeap classes, private-member conventions, dependencies, code patterns, and configuration
- [Extension Guide](extension-guide.md) -- Guidance for common feature additions and extension points
- [Project Structure](project-structure.md) -- Source layout and component overview
- [Improvements](improvements.md) -- Tracked improvement opportunities
- [Release](release.md) -- Release process
- [Deprecation Remediation](deprecation-remediation.md) -- Corrective deprecation text for the published versions that shipped `.git/config`
