# TODO

This TODO is ordered for a route-validation v2, not a full product rebuild.

## Current Flow Validation Queue

- [ ] `[预算追加]` / `18e54abfc53bcb3841ef78b4b8980f5d` — pending re-generation and NewOA validation after translator fixes:
  - detail-table unbound title labels now prefer the title-row text, e.g. `成本中心编码`.
  - designer `linkLabel` controls now draft as `xform-description` with visible text plus URL, covering links such as `采购需求清单模板`.
  - 2026-07-19 regenerated DSL passes execute check, but target write is blocked: configured category `1jt7ujnskw1swdv7dw3gigglp1l4ljbrjow0` resolves to `{}` in `.tmp/newoa.env` target; `kmReviewTemplate/add` returns `errors.unknown`.
  - 2026-07-19 updated target environment under category `1jtat3cg8w6hw3os9w32a6mif12nrp5n2sw0`: new template `1jtsik2f6w2kw28d8w2robq9m33vnh3b3nw0`; readback passed with warnings.
  - 2026-07-19 linkLabel controls now use native MK `xform-hyperlinks`; target template `1jtsik2f6w2kw28d8w2robq9m33vnh3b3nw0` was updated and readback verified 4 hyperlink controls.
- [ ] `采购项目付款申请` / `1887a98750756b5ba35b02047e6a6a30` — code-side fixes covered by regression tests, but not yet updated to the target NewOA environment:
  - post/position address controls preserve native MK org type and current-post default values.
  - legacy RTF controls migrate to MK rich-text controls instead of multiline text.
  - full-row prompt text labels are preserved as descriptions.
  - workflow finance branch formulas, editable-handler-node links, process privilege users, and timeout settings are preserved.
  - 2026-07-19 regenerated DSL passes execute check, but target write is blocked: historical target `1jtb8srdlw6hw41urw2ea188k3v5u2ov2kw0` is already published/non-draft and belongs to category `1jtat3cg8w6hw3os9w32a6mif12nrp5n2sw0`; creating a new draft under configured category `1jt7ujnskw1swdv7dw3gigglp1l4ljbrjow0` also fails at `kmReviewTemplate/add`.
  - 2026-07-19 updated target environment under category `1jtat3cg8w6hw3os9w32a6mif12nrp5n2sw0`: new template `1jtsikgfuw2kw28hrwsd3uph1ii9lbk30iw0`; readback failed on `fd_apply_post.defaultValue` plus workflow edge condition native semantics (`L39`, `L49`, `L76`).
- [ ] `重大质量信息快报` / `149c6e78f7c015f4c7da952411fa0cef` — DSL generation/trust/execute checks pass after translator fixes, but not yet updated to the target NewOA environment:
  - designer-only executable controls without metadata no longer create manual-review warnings.
  - same-fragment JSP helper functions are preserved for event translation and no longer fail function whitelist checks.
  - `hideAll + judgeMethod(input1,input2,input3)` row visibility/required matrix is translated deterministically to literal `MKXFORM.setFieldAttr` row-marker calls.
  - the same row visibility/required matrix now also lowers to native MK `formRules.linkage` display/require rules for target-environment display-rule matching.
  - datetime controls preserve `yyyy-MM-dd HH:mm`; `报告时间` maps legacy `nowTime` / `DateTimeFunction.getNow()` to a current-time default.
  - 2026-07-19 regenerated DSL passes execute check, but target write is blocked: historical target `1jtb8rka1w6hw4193w3c5i0g14rrm3eealw0` is already published/non-draft and belongs to category `1jtat3cg8w6hw3os9w32a6mif12nrp5n2sw0`; creating a new draft under configured category `1jt7ujnskw1swdv7dw3gigglp1l4ljbrjow0` also fails at `kmReviewTemplate/add`.
  - 2026-07-19 updated target environment under category `1jtat3cg8w6hw3os9w32a6mif12nrp5n2sw0`: new template `1jtsikm0iw2kw28lhw2n55ugh1d5l0qddmw0`; readback failed on `fd_appr_time.defaultValue` and missing persisted form-rule semantics.
- [ ] `投产通知单下发流程（新）` / `18b940a16be81952fdd4eb64816aa02c` — DSL generation/trust/execute checks pass after translator fixes, but not yet updated to the target NewOA environment:
  - legacy window-load row visibility scripts using `GetXFormFieldValueById(...) == ...` now lower to native MK `formRules.linkage` load rules.
  - form-side legacy script actions are fully covered by generated native rules; no form script action remains `needs_review`.
  - workflow branch conditions are preserved as display-only formulas for executor projection; current validation still reports them as non-blocking `workflow.condition.display_only` warnings.
  - 2026-07-19 regenerated DSL passes execute check, but target write is blocked: configured category `1jt7ujnskw1swdv7dw3gigglp1l4ljbrjow0` resolves to `{}` in `.tmp/newoa.env` target; `kmReviewTemplate/add` returns `errors.unknown`.
  - 2026-07-19 updated target environment under category `1jtat3cg8w6hw3os9w32a6mif12nrp5n2sw0`: new template `1jtsil1piw2kw28ovw3cq1aqj3a6an0q19w0`; readback failed on `fd_3848c57f481136.defaultValue`.

## Milestone 0: Repo Baseline

- [x] Create a clean v2 repository.
- [x] Add a no-dependency Node ESM project skeleton.
- [x] Add minimal CLI commands: `translate`, `validate`, `dry-run`, `execute`.
- [x] Add initial DSL validation and dry-run tests.
- [x] Record the v2 architectural boundary in ADR form.

## Milestone 1: SysFormTemplate XML Intake

- [x] Add one SysFormTemplate XML fixture under `tests/fixtures/source/`.
- [x] Document the source shape in `docs/operations/source-format.md`.
- [x] Replace the sample JSON adapter with a SysFormTemplate XML adapter.
- [x] Keep the adapter narrow: support only `*_SysFormTemplate.xml`.
- [ ] Add parser diagnostics for missing template name, missing fields, unsupported field types, and ambiguous options.
- [ ] Replace the bootstrap fixture with a real production-like sample from the current source export.
- [x] Parse `fdDesignerHtml` layout order instead of relying only on `fdMetadataXml`.
- [ ] Preserve hidden/source-only fields for rule references without treating them as visible controls.

## Milestone 2: DSL Contract

- [ ] Decide whether the file name remains `structured_form.json` or changes to `migration_dsl.json`.
- [ ] Promote `src/dsl/schema.js` from draft validation into the canonical v2 schema.
- [ ] Add branch/effect-level `formRules` modeling before implementing rule writes.
- [x] Add `review` entries for translation warnings that do not block execution.
- [x] Add fixture coverage for valid DSL, invalid DSL, and DSL with warnings.

## Milestone 3: NewOA API Spike

- [x] Identify the minimum NewOA APIs required to create or update a test template.
- [x] Port only the smallest useful API helper from v1, or rewrite it from scratch.
- [x] Implement API login with encrypted password input; no browser login/storage state.
- [x] Create a new `MK_TEST_` template from one minimal DSL through the executor seam.
- [x] Read back the saved template and compare form/workflow structure.
- [x] Fail closed on missing `confirmWrite`, missing category, unsafe base URL, credentials, and readback mismatch.

## Milestone 4: Minimal Execution Report

- [x] Emit a JSON report containing plan, diagnostics, template id, stage, and readback result.
- [ ] Emit a Markdown report for human review.
- [x] Preserve `needs_manual` as a non-blocking warning status.
- [x] Distinguish blocking safety errors from non-blocking migration review warnings.

## Milestone 5: Expand Only After Route Proof

- [ ] Add more field types only after the minimal template write is proven.
- [ ] Add form rule API writes only after branch/effect DSL semantics are settled.
- [x] Add first-version workflow graph write/readback for paired XML route-validation.
- [ ] Add batch only after single-flow execution is boring.
- [ ] Add frontend only if CLI operation becomes the bottleneck.

## Explicit Non-Goals For Now

- [ ] Do not support source formats outside the current XML route-validation scope.
- [ ] Do not build a React workbench.
- [ ] Do not port v1 Tool Test Page.
- [ ] Do not add PI/Agent execution.
- [x] Do not implement full flow migration before the form route is proven.
