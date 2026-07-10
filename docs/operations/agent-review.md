# AI Agent Review Workflow

The intended route-validation operator path is:

```text
clean -> draft -> agent-review -> migration.dsl.json -> check/dry-run/execute
```

`clean`, `draft`, and `translate` are deterministic and offline. `translate` remains only a shortcut for clean plus draft, and it never calls AI.

## Provider Configuration

`agent-review` uses an OpenAI-compatible Responses API provider and reads its connection configuration from environment variables:

- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`

Initial review and repair requests always use `gpt-5.6-luna`. The model cannot be overridden, and a failed request does not fall back to another model.

The provider calls:

```text
POST {OPENAI_BASE_URL}/v1/responses
```

Do not pass the API key through CLI arguments. Keep local values in an ignored file such as `.temp/newoa.env`:

```bash
export OPENAI_BASE_URL='http://154.9.255.164:8317'
export OPENAI_API_KEY='sk-...'
```

Source it explicitly when you want a real provider call:

```bash
source .temp/newoa.env
node src/cli/main.js agent-review .tmp/sample/source-draft.json .tmp/sample/dsl-draft.json \
  --out .tmp/sample/migration.dsl.json \
  --report-out .tmp/sample/agent-review.report.json
```

The command never prints or stores `OPENAI_API_KEY`. Reports may include `baseUrl` and `model`.

## Patch Contract

The AI returns strict JSON with exactly:

- `summary`
- `patches`
- `diagnostics`

It must not return a complete DSL. Local code validates the patch response, applies only accepted patches, validates the patched draft, promotes it to trusted DSL, and runs trust checks before writing `migration.dsl.json`.

First-version patches support only `op = "replace"` on these form DSL paths:

- `/form/fields/*/title`
- `/form/fields/*/type`
- `/form/fields/*/componentId`
- `/form/fields/*/props`
- `/form/fields/*/columns/*/title`
- `/form/fields/*/columns/*/type`
- `/form/fields/*/columns/*/componentId`
- `/form/fields/*/columns/*/props`

Workflow, trust, executor safety, source artifact, credentials, environment, and config paths are rejected. Workflow is diagnostic-only in v1.

Title patches require `confidence >= 0.7`. Type, component, and props patches require `confidence >= 0.85`. Props patches are limited to `required`, `options`, and `maxLength` and must be supported by source evidence.

Warning-only diagnostics can still produce trusted executable DSL. Error or blocked diagnostics, malformed JSON, unsafe patch paths, low confidence, missing evidence/source refs/rationale, or failed DSL/trust validation block output. On blocked review, `--out` is not written; `--report-out` receives a sanitized blocked report.

## Live Smoke

Default tests remain offline:

```bash
npm test
```

The live smoke is separate and expects env to already be present:

```bash
source .tmp/newoa.env
npm run test:agent-review:live
```

The smoke does not source `.tmp/newoa.env` by itself. With env present, it calls the real `/v1/responses` endpoint, writes artifacts under `.tmp/agent-review-live/`, and validates whether the provider produced the expected layered JSP review outcome or a clear blocked report. NewOA SIT writes are attempted only for fixtures configured in `execute` mode that produce trusted DSL and have a target category fdId.
