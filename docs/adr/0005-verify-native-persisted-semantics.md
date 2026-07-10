# Verify native persisted semantics after NewOA writes

Readback verification compares persisted invariants expected from the complete trusted DSL with invariants observed from NewOA's native persisted template structure. It does not treat a returned write payload or migration audit markers as proof of success, and it does not claim to verify designer or runtime behavior; this keeps the API-first Executor fail-closed on semantic persistence loss without expanding the v2 route-validation boundary into browser or runtime testing.

**Status**: accepted

## Consequences

- The complete trusted DSL produces one canonical expected model that the NewOA writer may consume.
- A separate observer decodes NewOA's native persisted structure into the same invariant schema; it does not reuse writer extraction logic.
- Expected invariants are never derived from a rendered payload, a returned write payload, or migration audit markers.
- Loss or mutation of an Executor-supported executable DSL semantic is an error. Explicitly partial or `needs_manual` semantics may produce warnings, while platform-owned defaults, manual additions, coordinates, and styling are ignored unless the route contract explicitly owns them.
- Every error-level persisted invariant requires tracked fixture evidence and a mutation test through the persistence Module Interface. Public Route cases remain representative of externally distinct execution outcomes rather than duplicating the full invariant matrix.

## Initial invariant matrix

- Form invariants include stable field, detail-table, and detail-column identity; title; canonical type and component; catalog-supported executable props; data-only visibility; and structural layout order, membership, references, and spans.
- Form comparison uses effective canonical semantics rather than requiring one exact NewOA serialization location.
- Source references, source properties, generation reasons, CSS, pixel styling, and platform-owned internal IDs or defaults are not form persisted invariants unless a later Route case explicitly owns them.
- Executable form rules are compared as an expected semantic subset of observed native rules, including logic, conditions, and effects. Counts and migration markers are insufficient evidence, while unrelated manual rules are allowed.
- Executable script invariants include action identity, event, scope, control and detail-table binding, the deterministically rendered native JavaScript body, and any canonical view-status guard. This verifies persisted source, not runtime behavior; actions omitted in favor of native form rules must not be rendered as executable scripts.
- Workflow invariants include readable content; stable node and edge identity; node names and canonical native types; edge endpoints, default-route and branch ownership; supported condition semantics; supported participant handlers; node data authority; and any advanced configuration explicitly backed by a Route case. Graphs are compared by identity and relationships rather than raw element-array order.
- Explicitly partial workflow semantics may warn, while loss or mutation of a supported condition, participant, authority, or graph relationship is an error. Coordinates, connector waypoints, styling, and unsupported advanced attributes are not error-level invariants.
- Template-envelope invariants include the created template ID, generated `MK_TEST_` name, requested category, draft and unpublished state, generated table name, and consistent form/workflow bindings. Their expected values come from Executor execution context and remain outside DSL.
- Native template observation uses strict section-scoped decoders. Missing, malformed, or wrong-typed required structures produce precise decode errors and suppress dependent comparisons for that section instead of silently becoming empty objects or cascades of count mismatches; independent sections may still be checked.
- Workflow projection is exhaustive over the explicit workflow node types accepted by executable DSL. Source-like or unknown types are resolved before the Executor seam or rejected by DSL validation; the Executor never heuristically downgrades them to `review`.
- After filtering versioned platform-owned system/default artifacts, form structure, scripts, and workflow use closed-world comparison: unexpected domain fields, columns, layout references, actions, nodes, or edges are errors. Executable form rules are the explicit open-world exception because unrelated manual rules may coexist with the expected semantic subset.

## Module interface

The in-process persistence module exposes one preparation entry point. `preparePersistedTemplate({ dsl, envelope, baseTemplate })` returns an opaque native update payload together with a bound, deterministic `verify(readbackTemplate)` capability. Its Implementation hides the versioned invariant schema, form/workflow writers, independent native observers, comparison policy, strict decoding, and diagnostics; no family registry, writer, observer, comparator, NewOA Adapter, or dry-run operation is exposed through this Interface.

The module Seam begins after the created template's first `getTemplate` and before `updateTemplate`. `executeDsl` continues to own login, initialization, table/category lookup, creation, both Adapter calls around persistence, and execution reporting; create-payload and full-route orchestration remain outside this candidate.

`ReadbackVerification` exposes an invariant schema version, stable per-partition status, stable form/workflow summaries, and precise diagnostics with canonical invariant keys and native decode paths. Complete expected/observed models, raw templates, and update payloads remain hidden; large values such as JavaScript bodies are represented by digests in diagnostics.

Readback verification performs one update, one readback fetch, and one verification pass. It does not retry, rewrite, repair, reconcile, or mutate DSL; a failed `MK_TEST_` draft and its created ID remain available as evidence. Any future read-only retry requires observed SIT evidence and fixture coverage, while repair would be a separate explicit Executor operation.

Preparation failures are structured values mapped by `executeDsl` to the existing `status: "failed"` with `stage` and `failedAt` set to `projection`; they retain any created template ID and do not introduce a new top-level execution status. Strict readback decode failures and invariant mismatches retain `status: "readback_failed"`. Programming defects may still throw and are reported as projection-stage internal errors.

Migration audit metadata may remain in written templates for diagnosis, but observers ignore it as verification evidence. Dry-run remains outside this Module Interface because it has no persisted template or execution envelope. The existing `executeDsl` Interface and stable `readback.form`/`readback.workflow` summaries remain compatible while invariant version and partition status are added.

## Testing

- Exhaustive form, rule, script, workflow, envelope, and decode mutations are tested through `preparePersistedTemplate(...).verify(...)` using tracked native evidence independent from writer-produced payloads.
- Public Route cases continue to prove the stable Executor outcomes, including one representative `readback_failed` route, and expand only when externally observable behavior or supported product scope changes.
- Tests that directly import writer, observer, summary, or comparator helpers are replaced once equivalent Interface tests exist; NewOA transport normalization remains covered at the existing Adapter Seam.
