# mk-migrate-agent-v2

`mk-migrate-agent-v2` is a clean route-validation rebuild for NewOA/MK migration execution.

The first version is deliberately narrow:

```text
SysFormTemplate XML -> DSL -> validate -> dry-run -> API-first execute spike
```

This repo is not a full replacement for `mk-migrate-agent` yet. The old repo remains the knowledge base for NewOA API behavior, payload shapes, readback checks, and historical fixtures.

## Current scope

- Single source shape only: `*_SysFormTemplate.xml`.
- DSL is the only public boundary between translation and execution.
- No frontend.
- No batch execution.
- No PI/Agent execution path.
- No legacy Landray/K2 source compatibility.
- API-first execution; browser automation is only allowed for login or fallback spikes.

## Commands

```bash
npm test

node src/cli/main.js translate tests/fixtures/source/sysform-fixture-id_SysFormTemplate.xml --out .tmp/sample.dsl.json
node src/cli/main.js validate .tmp/sample.dsl.json
node src/cli/main.js dry-run .tmp/sample.dsl.json
node src/cli/main.js execute .tmp/sample.dsl.json --confirm-write
```

`execute` is intentionally a guarded placeholder until the NewOA API write spike is proven.

## Repository shape

```text
src/cli/          # thin command-line entry
src/dsl/          # DSL schema and validation
src/translator/   # source adapter: SysFormTemplate XML -> DSL
src/executor/     # DSL -> dry-run plan / API execution spike
tests/fixtures/   # minimal route-validation samples
docs/adr/         # architecture decisions
docs/operations/  # operating notes
```

## Decision checkpoint

The first milestone succeeds only when one real SysFormTemplate XML file can produce DSL, validate, dry-run, write a test template through NewOA API, read back the result, and emit a report.
