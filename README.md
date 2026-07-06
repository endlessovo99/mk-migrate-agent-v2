# mk-migrate-agent-v2

`mk-migrate-agent-v2` is a clean route-validation rebuild for NewOA/MK migration execution.

The first version is deliberately narrow:

```text
SysFormTemplate/LbpmProcessDefinition XML
  -> clean source-draft.json
  -> draft dsl-draft.json
  -> external Codex Agent trust migration.dsl.json
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

# Records that an external Codex Agent reviewed the source draft, draft DSL, catalogs, and policy.
node src/cli/main.js trust .tmp/sample/source-draft.json .tmp/sample/dsl-draft.json \
  --external-agent-reviewed \
  --reviewer-name codex \
  --out .tmp/sample/migration.dsl.json

node src/cli/main.js check trust .tmp/sample/source-draft.json .tmp/sample/migration.dsl.json
node src/cli/main.js check execute .tmp/sample/migration.dsl.json
node src/cli/main.js dry-run .tmp/sample/migration.dsl.json --out .tmp/sample/dry-run.report.json
NEWOA_USERNAME=01025344 \
NEWOA_ENCRYPTED_PASSWORD='...' \
node src/cli/main.js execute .tmp/sample/migration.dsl.json \
  --confirm-write \
  --target-category-id '<NewOA category fdId>'
```

`translate` remains a compatibility shortcut for `clean` plus `draft`, so it writes a non-executable `dsl-draft.json`. `dry-run` and `execute` accept only trusted `migration.dsl.json` with `trust.level = trusted` and `trust.executable = true`.

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

## Decision checkpoint

The first milestone succeeds only when one real paired source XML directory can produce source draft, DSL draft, trusted migration DSL, check reports, dry-run report, and then, behind the explicit SIT write gates, a verified `MK_TEST_` draft template through NewOA API.
