# TODO

This TODO is ordered for a route-validation v2, not a full product rebuild.

## Milestone 0: Repo Baseline

- [x] Create a clean v2 repository.
- [x] Add a no-dependency Node ESM project skeleton.
- [x] Add minimal CLI commands: `translate`, `validate`, `dry-run`, `execute`.
- [x] Add initial DSL validation and dry-run tests.
- [x] Record the v2 architectural boundary in ADR form.

## Milestone 1: Real Source Intake

- [ ] Add one real latest-format source file under `tests/fixtures/source/`.
- [ ] Document the exact source shape in `docs/operations/source-format.md`.
- [ ] Replace the sample JSON adapter with the real source adapter.
- [ ] Keep the adapter narrow: support only the current source shape.
- [ ] Add parser diagnostics for missing template name, missing fields, unsupported field types, and ambiguous options.

## Milestone 2: DSL Contract

- [ ] Decide whether the file name remains `structured_form.json` or changes to `migration_dsl.json`.
- [ ] Promote `src/dsl/schema.js` from draft validation into the canonical v2 schema.
- [ ] Add branch/effect-level `formRules` modeling before implementing rule writes.
- [ ] Add `review` entries for translation warnings that do not block execution.
- [ ] Add fixture coverage for valid DSL, invalid DSL, and DSL with warnings.

## Milestone 3: NewOA API Spike

- [ ] Identify the minimum NewOA APIs required to create or update a test template.
- [ ] Port only the smallest useful API helper from v1, or rewrite it from scratch.
- [ ] Implement login/storage-state handling only if the API requires browser-authenticated cookies.
- [ ] Create/update an `MK_TEST_` template from one minimal DSL.
- [ ] Read back the saved template and compare fields by stable ids/titles.
- [ ] Fail closed on missing `confirmWrite`, non-test smoke targets, and readback mismatch.

## Milestone 4: Minimal Execution Report

- [ ] Emit a JSON report containing input path, DSL summary, plan, API calls, diagnostics, and readback result.
- [ ] Emit a Markdown report for human review.
- [ ] Preserve `needs_manual` as a non-blocking warning status.
- [ ] Distinguish blocking safety errors from non-blocking migration review warnings.

## Milestone 5: Expand Only After Route Proof

- [ ] Add more field types only after the minimal template write is proven.
- [ ] Add form rule API writes only after branch/effect DSL semantics are settled.
- [ ] Add flow only after form write/readback is stable.
- [ ] Add batch only after single-flow execution is boring.
- [ ] Add frontend only if CLI operation becomes the bottleneck.

## Explicit Non-Goals For Now

- [ ] Do not support legacy Landray/K2/SysFormTemplate sources.
- [ ] Do not build a React workbench.
- [ ] Do not port v1 Tool Test Page.
- [ ] Do not add PI/Agent execution.
- [ ] Do not implement full flow migration before the form route is proven.
