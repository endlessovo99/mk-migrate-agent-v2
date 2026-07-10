# Use one offline Route-validation harness for public route tests

Public Route case tests use a test-owned Route-validation harness with one `runRouteCase` interface. Each case starts from a supported XML input, crosses the production Agent Review, DSL, dry-run, and Executor interfaces with deterministic fake adapters, and returns a thin result envelope around the real public artifacts; payload, readback, transport, fixture loading, scenarios, and transcripts remain internal to the harness or their owning production modules.

**Status**: accepted

## Consequences

- The public route suite covers only the form-only success, paired success, warning-but-executable, blocked-before-transport, and readback-loss outcomes, and it runs in default `npm test`.
- Route case manifests are declarative data, use minimal sanitized tracked fixtures, and may reference only finite named review and NewOA scenarios.
- The harness injects a deterministic fake review provider and a minimal stateful fake NewOA adapter, while a fail-fast network guard makes accidental external access an integrity error.
- Public route tests assert stable semantics through DSL, dry-run, Executor reports, readback summaries, and sanitized transcripts; detailed payload, parser, transport, and projection assertions remain module or internal tests.
- New public-seam tests replace overlapping path-based tests rather than layering another suite on top.
- Production code must not depend on the harness, and DSL remains the only public artifact between Translator and Executor.
