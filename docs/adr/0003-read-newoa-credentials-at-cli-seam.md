# Read NewOA credentials and target configuration at the CLI seam

The production CLI reads `NEWOA_USERNAME`, `NEWOA_ENCRYPTED_PASSWORD`, and optional `NEWOA_BASE_URL` from the environment and passes the resulting values into the Executor request. `--base-url` takes precedence over `NEWOA_BASE_URL`; an empty or whitespace-only value is treated as unspecified, and the default is `https://p-sit.onewo.com`. The live-smoke entry point reads the same base URL environment variable and uses the same default.

The Executor does not read `process.env`. It accepts `options.baseUrl`, normalizes and validates that value as an HTTP/HTTPS root origin, and blocks with `safety.base_url_invalid` before login when the value is invalid. The Route-validation harness supplies fixed non-secret test values without mutating global environment state.

**Status**: accepted

## Consequences

- The production write path still accepts credentials only through environment variables; no credential CLI flags are added.
- A one-command `--base-url` override is allowed because the target origin is not a secret. Resolution order is `--base-url` > `NEWOA_BASE_URL` > `https://p-sit.onewo.com`.
- The target may be any valid HTTP/HTTPS root origin. It is normalized before requests and reporting; it is not restricted by a host allowlist.
- Selecting a non-SIT origin does not weaken or duplicate the existing explicit confirmation, category, `MK_TEST_` draft-only, and readback gates.
- Temporary participant and condition-organization fallback fdIds remain available only at the exact normalized origins `https://p-sit.onewo.com`, `http://mkpaaspoc.shanghai-electric.com`, and `http://oa-dev.shanghai-electric.com:8088`.
- Credentials must never enter DSL, Route case manifests, transcripts, reports, or persisted test artifacts.
- Default tests remain deterministic and can run without real NewOA credentials.
