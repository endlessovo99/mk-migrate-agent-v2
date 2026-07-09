# mk-migrate-agent-v2

`mk-migrate-agent-v2` is a clean route-validation rebuild for NewOA/MK migration execution.

The first version is deliberately narrow:

```text
SysFormTemplate/LbpmProcessDefinition XML
  -> clean source-draft.json
  -> draft dsl-draft.json
  -> agent-review migration.dsl.json
  -> check execute -> dry-run -> API-first execute
```

This repo is not a full replacement for `mk-migrate-agent` yet. The old repo remains the knowledge base for NewOA API behavior, payload shapes, readback checks, and historical fixtures.

## Current scope

- Supported source shapes: a single `*_SysFormTemplate.xml`, or a paired source directory with one `*_SysFormTemplate.xml` and one `*_LbpmProcessDefinition.xml`.
- DSL is the only public boundary between translation and execution.
- No frontend.
- No batch execution.
- No PI/Agent execution path.
- API-first execution; browser automation is not used by the v2 executor.
- NewOA writes are locked to SIT and require explicit confirmation, credentials, and a target category `fdId`.

## Commands

```bash
npm test

node src/cli/main.js clean tests/fixtures/source/route-validation-lbpm --out .tmp/sample/source-draft.json
node src/cli/main.js draft .tmp/sample/source-draft.json --out .tmp/sample/dsl-draft.json
node src/cli/main.js check draft .tmp/sample/dsl-draft.json

# Explicit AI review stage. The model returns restricted patches; local code validates and applies them.
source .tmp/newoa.env
node src/cli/main.js agent-review .tmp/sample/source-draft.json .tmp/sample/dsl-draft.json \
  --out .tmp/sample/migration.dsl.json \
  --report-out .tmp/sample/agent-review.report.json

node src/cli/main.js check trust .tmp/sample/source-draft.json .tmp/sample/migration.dsl.json
node src/cli/main.js check execute .tmp/sample/migration.dsl.json
node src/cli/main.js dry-run .tmp/sample/migration.dsl.json --out .tmp/sample/dry-run.report.json
NEWOA_USERNAME=01025344 \
NEWOA_ENCRYPTED_PASSWORD='...' \
node src/cli/main.js execute .tmp/sample/migration.dsl.json \
  --confirm-write \
  --target-category-id '<NewOA category fdId>'
```

`translate` remains a deterministic compatibility shortcut for `clean` plus `draft`. It does not call AI and writes a non-executable `dsl-draft.json`. `agent-review` is the only AI-backed stage. `dry-run` and `execute` accept only trusted `migration.dsl.json` with `trust.level = trusted` and `trust.executable = true`.

`agent-review` reads `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` from the environment and calls `POST {OPENAI_BASE_URL}/v1/responses`. Keep local secrets in an ignored file such as `.tmp/newoa.env`, then source it explicitly before review or live smoke:

```bash
source .tmp/newoa.env
npm run test:agent-review:live -- --target-category-id '<NewOA category fdId>'
```

Default `npm test` is offline and uses fake review providers only. The live smoke is separate, uses the real provider, writes one `MK_TEST_...` draft template to NewOA SIT for the execute fixture, and writes sanitized artifacts under `.tmp/agent-review-live/`. The partial-translation fixture is reviewed as a script-only slice so the real Agent validates JSP-to-JS behavior without sending unrelated workflow payload.

The AI reviewer returns JSON patches, not a complete DSL. First-version patches are limited to form field/detail-column `title`, `type`, `componentId`, and `props` paths plus existing `scripts.actions[]` `function`, `translationStatus`, `functionMappings`, and `coverage` paths. Generated MK JavaScript coverage is recorded as `coverage.status = "translated"`; review-grade target APIs require explicit `functionMappings` before execution. Workflow review is diagnostic-only: warning diagnostics may remain in trusted DSL, while error or blocked diagnostics prevent `migration.dsl.json` from being written.

`execute` creates a new `MK_TEST_...` template in NewOA SIT, saves it as draft, reads it back, and reports the created `fdId`. Warning-only trusted DSL (`needs_manual`) is executable; DSL errors and safety errors block before login. If creation succeeds and a later stage fails, the report keeps the partial fdId and does not auto-rollback.

## Repository shape

```text
src/cli/          # thin command-line entry
catalogs/         # versioned component, function, and validation-policy contracts
src/dsl/          # DSL schema, trust checks, and execution checks
src/translator/   # source XML -> source-draft -> non-executable dsl-draft
src/executor/     # trusted DSL -> dry-run plan / API-first NewOA execution
tests/fixtures/   # minimal route-validation samples
docs/adr/         # architecture decisions
docs/operations/  # operating notes
```

## Catalog maintenance

The executable DSL is checked against versioned catalogs under `catalogs/`. When MK/NewOA support changes, update the focused catalog instead of widening validation in code:

- `mk-components.v1.json`: target MK form/layout components and executable props.
- `mk-control-events.v1.json`: target control/global script events by MK component and scope.
- `mk-js-snippets.v1.json`: browser-verified MK editor JS snippets, including `MKXFORM.*` usage examples by snippet category.
- `js-methods.v1.json`: base JavaScript globals, static methods, and instance methods allowed inside translated MK form scripts.
- `functions.v1.json`: legacy source JSP functions and their MK migration intent.

For `js-methods.v1.json`, add only methods with auditable evidence from route-validation fixtures, exported MK examples, MK documentation, or existing function catalog examples. Include a short `evidence` and `notes` entry, bump the catalog version, and add an offline DSL validation test with one accepted call and one unsupported call. Keep DOM APIs, browser storage, dynamic code execution, and network primitives out of this catalog unless a separate design explicitly expands the trust boundary.

## Decision checkpoint

The first milestone succeeds only when one real paired source XML directory can produce source draft, DSL draft, trusted migration DSL, check reports, dry-run report, and then, behind the explicit SIT write gates, a verified `MK_TEST_` draft template through NewOA API.
