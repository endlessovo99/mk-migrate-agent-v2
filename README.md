# mk-migrate-agent-v2

`mk-migrate-agent-v2` is a clean route-validation rebuild for NewOA/MK migration execution.

The first version is deliberately narrow:

```text
SysFormTemplate/LbpmProcessDefinition XML -> DSL -> validate -> dry-run -> API-first execute
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

node src/cli/main.js translate tests/fixtures/source/route-validation-lbpm --out .tmp/sample.dsl.json
node src/cli/main.js validate .tmp/sample.dsl.json
node src/cli/main.js dry-run .tmp/sample.dsl.json
NEWOA_USERNAME=01025344 \
NEWOA_ENCRYPTED_PASSWORD='...' \
node src/cli/main.js execute .tmp/sample.dsl.json \
  --confirm-write \
  --target-category-id '<NewOA category fdId>'
```

`execute` creates a new `MK_TEST_...` template in NewOA SIT, saves it as draft, reads it back, and reports the created `fdId`. Warning-only DSL (`needs_manual`) is executable; DSL errors and safety errors block before login.

## Repository shape

```text
src/cli/          # thin command-line entry
src/dsl/          # DSL schema and validation
src/translator/   # source adapter: SysFormTemplate XML -> DSL
src/executor/     # DSL -> dry-run plan / API-first NewOA execution
tests/fixtures/   # minimal route-validation samples
docs/adr/         # architecture decisions
docs/operations/  # operating notes
```

## Decision checkpoint

The first milestone succeeds only when one real SysFormTemplate XML file can produce DSL, validate, dry-run, write a test template through NewOA API, read back the result, and emit a report.
