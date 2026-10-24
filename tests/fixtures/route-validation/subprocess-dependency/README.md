# Subprocess dependency preflight evidence

`native-reads.json` retains the exact selected response fields, empty
`processTempVars._all`, and structured `noRecord` chains from the read-only
2026-10-24 internal LBPM lookup. Identifiers are replaced with deterministic
fixture IDs. Request contracts are:

- `POST /data/sys-lbpm/lbpmTemplate/details` with `{ "templateId": "<internal LBPM ID>" }`.
- `POST /data/sys-lbpm/params/find` with `{ "reqParams": { "processTemplateId": "<internal LBPM ID>" }, "keys": { "processTemplateInfo": ["latestDefinitionId"], "processTempVars": ["_all"] } }`.

The retained live evidence summarized the definition graph without saving its
content. `repositoryDefinitionGraph` is therefore an explicitly labeled minimal
repository structure sample using the native node/edge keys emitted by
`src/executor/persistence/workflow-writer.js`. It is not the live positive control
graph and is not evidence of business runtime acceptance.

The only positive execution contract is an exact published, enabled internal
LBPM ID, a complete connected JSON definition graph, the same definition ID in
both reads, a complete empty variable list, zero input/recovery mappings, and
zero business model/createParam/dictBean bindings. Nonempty variables, mappings,
legacy expressions, business namespaces, missing fields and unknown parameter
metadata fail closed. Empty `_all` does not prove any field or parameter mapping.

The route cases reuse the tracked paired `subprocess/` XML, so both the absent
dependency and the unproved parameterized business contract reach production
`executeDsl` after the normal review/trust path. All clients are local fakes and
the route network guard remains enabled.
