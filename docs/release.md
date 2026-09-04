# Release Process

This package follows the Stonyx shared release pipeline managed by [stonyx-workflows](https://github.com/abofs/stonyx-workflows).

See [stonyx-workflows/docs/release.md](https://github.com/abofs/stonyx-workflows/blob/main/docs/release.md) for the full release process, versioning scheme, and cascade publishing details.

**npm package:** `@stonyx/cron`

## Remediation of already-published versions

Registry metadata on versions that are already published is corrected out-of-band,
not through the release pipeline. See
[Deprecation Remediation](deprecation-remediation.md) for the current case
(22 versions that shipped `package/.git/config`) and the runbook for applying it.
