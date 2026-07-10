# Read NewOA credentials at the CLI seam

The production CLI reads `NEWOA_USERNAME` and `NEWOA_ENCRYPTED_PASSWORD` from the environment and passes the resulting credential values into the Executor request. The Executor does not read `process.env`; it validates that credentials are present before invoking the NewOA adapter, while the Route-validation harness supplies fixed non-secret test values without mutating global environment state.

**Status**: accepted

## Consequences

- The production write path still accepts credentials only through environment variables; no credential CLI flags are added.
- Credentials must never enter DSL, Route case manifests, transcripts, reports, or persisted test artifacts.
- Default tests remain deterministic and can run without real NewOA credentials.
