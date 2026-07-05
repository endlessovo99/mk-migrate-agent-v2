---
title: API-first NewOA designer execution for DSL layout and workflow
labels:
  - ready-for-agent
status: ready-for-agent
---

## Problem Statement

The route-validation version can translate source XML into DSL and dry-run the migration shape, but it cannot yet execute the DSL into a NewOA/MK test template. The current executor is intentionally guarded and does not perform NewOA writes.

The user needs the v2 product to include both a translator and an executor. The executor must create a real NewOA SIT test template from DSL, write the form and workflow into the NewOA designer data model, save it as draft, read it back, and report the created template `fdId`. The executor must remain narrow, API-first, and source-agnostic, with DSL as the only public boundary between translation and execution.

The user also needs the form DSL to carry layout information from `fdDesignerHtml`. A flat field list is insufficient because the NewOA designer output must preserve the source form's row and column relationships at a structural level.

## Solution

Build the first vertical slice of the NewOA/MK executor around a single confirmed SIT write path:

DSL is validated, translated into a dry-run plan, written through NewOA APIs into a newly created `MK_TEST_...` template, saved as draft, read back, structurally verified, and reported with the created `fdId`.

The translator will be upgraded to produce a designer-first form model:

- `fdDesignerHtml` is the primary source for visible form controls and layout.
- `fdMetadataXml` enriches controls with type, required, options, and source metadata.
- DSL includes both field definitions and row/cell layout.
- Canonical DSL field IDs come from real designer controls, not from metadata-only IDs.
- Metadata-only mismatch is preserved as warning and audit data, not as the field identity.

The executor will be API-first:

- Login uses the NewOA login API directly.
- Template writes use only the minimum template-level APIs.
- Browser automation is not used for login or writing in the first version.
- The first version is locked to NewOA SIT.
- Templates are created as new test drafts only.

## User Stories

1. As a migration operator, I want to execute one DSL file into a NewOA SIT test template, so that I can verify the route from source XML to NewOA without manual designer work.
2. As a migration operator, I want the executor to return the created template `fdId`, so that I can open the NewOA template and inspect the result.
3. As a migration operator, I want every executed template to be created with an `MK_TEST_` prefix, so that test templates are clearly distinguishable from business templates.
4. As a migration operator, I want to pass the target NewOA category `fdId` explicitly, so that the executor does not guess category mappings from source XML.
5. As a migration operator, I want the executor to require an explicit write confirmation flag, so that accidental writes are blocked.
6. As a migration operator, I want the executor to block before login when confirmation, category, credentials, or environment checks fail, so that no unnecessary NewOA requests are sent.
7. As a migration operator, I want NewOA login to happen through API credentials, so that execution does not depend on browser state.
8. As a migration operator, I want encrypted NewOA password input to be read from environment variables, so that secrets are not printed in shell history or JSON output.
9. As a migration operator, I want the executor to save templates as drafts only, so that route-validation does not publish usable business processes.
10. As a migration operator, I want execution to be locked to SIT for the first version, so that production cannot be written by mistake.
11. As a migration operator, I want `needs_manual` DSL warnings to allow execution, so that structurally useful test templates can still be created for review.
12. As a migration operator, I want invalid DSL errors to block execution, so that malformed migrations do not create misleading NewOA templates.
13. As a migration operator, I want function whitelist violations to remain blocking errors, so that unsupported source-side functions are not silently migrated.
14. As a migration operator, I want readback verification after save, so that the executor reports whether NewOA accepted the expected structure.
15. As a migration operator, I want readback failures to include the failing stage and created `fdId`, so that I can inspect partial results in NewOA.
16. As a migration operator, I want failed test templates to be left in place, so that I can diagnose what was written without automatic cleanup changing the evidence.
17. As a translator maintainer, I want DSL form fields to use real designer control IDs from `fdDesignerHtml`, so that layout cells and field definitions refer to the same identity.
18. As a translator maintainer, I want metadata IDs preserved separately when they differ from designer IDs, so that the mismatch is auditable without breaking execution.
19. As a translator maintainer, I want `fdMetadataXml` to enrich designer controls by ID or unique label/type match, so that field types and options are as complete as possible.
20. As a translator maintainer, I want unmatched metadata fields reported as warnings, so that source metadata gaps are visible without creating invisible NewOA controls.
21. As a migration reviewer, I want form layout rows and cells represented in DSL, so that the executor can preserve row order and field grouping.
22. As a migration reviewer, I want row and column relationships preserved but not source CSS, so that the NewOA form is structurally familiar without depending on old HTML styling.
23. As a migration reviewer, I want detail tables to remain on their own layout row, so that table structure remains readable and verifiable.
24. As a migration reviewer, I want every field and detail column to carry its target MK component metadata, so that component mapping is explicit before execution.
25. As a workflow reviewer, I want `LbpmProcessDefinition XML` to be parsed as a directed acyclic graph, so that workflow nodes and edges can be verified before writing.
26. As a workflow reviewer, I want each workflow node and edge to preserve source attributes and definition data, so that later semantic mapping work has enough source evidence.
27. As a workflow reviewer, I want the first executor version to produce a NewOA-renderable workflow graph, so that the designer can show the complete route structure.
28. As a workflow reviewer, I want unsupported workflow semantics to become warnings, so that route structure can be reviewed before full runtime behavior is solved.
29. As a developer, I want the executor to use a fake NewOA client in default tests, so that `npm test` never writes to NewOA.
30. As a developer, I want the implementation to reuse only small pure functions from v1 knowledge where useful, so that v2 stays narrow and does not inherit broad v1 framework code.
31. As a developer, I want DSL to remain the only boundary between translator and executor, so that execution stays source-agnostic.
32. As a developer, I want the execution report to include plan, diagnostics, API stages, readback summary, and warnings, so that failures are actionable.

## Implementation Decisions

- v2 includes both a translator and an executor. The executor is in scope for the route-validation product, but it must stay narrow and API-first.
- The first executor version only creates a new NewOA SIT test template and saves it as draft.
- The executor must not update an existing template, delete a template, publish a template, run batch migration, auto-create categories, or write production.
- The executor uses only NewOA SIT in the first version. Other base URLs are rejected.
- The executor must require explicit write confirmation and explicit target category `fdId`.
- The target category is provided by the caller as `targetCategoryId`. It is not inferred from source XML category text or path.
- The template name is generated from the DSL template name with an `MK_TEST_` prefix and a uniqueness suffix.
- NewOA login is API-based. It posts the provided username and already encrypted password to the NewOA login endpoint as form URL encoded data.
- Login credentials are read from environment variables. The encrypted password is passed through directly as `j_password`; first version does not implement client-side password encryption.
- Secrets, login request bodies, cookies, and tokens are not written to disk and are not included in JSON output.
- The executor performs local validation and safety checks before making any login or write request.
- The first write API boundary is limited to template-level `add`, `get`, and `update`.
- Execution sequence is: validate DSL, check safety gates, login, create test template, get template detail, map DSL into template detail, update template draft, get readback, verify readback, return report.
- If create succeeds but a later stage fails, the executor does not roll back or delete the test template. It returns the created `fdId` and failure stage.
- `needs_manual` and other warning-only DSL states are executable. DSL errors are not executable.
- Function whitelist violations are DSL errors and block execution.
- The form translator becomes designer-first. Visible controls and layout come from `fdDesignerHtml`.
- `fdMetadataXml` enriches designer controls but does not independently create visible controls in the first version.
- Canonical DSL field IDs come from source designer controls, using the real control ID parsed from designer values or property references.
- Metadata IDs that differ from designer control IDs are preserved as source metadata on the field.
- Designer-to-metadata matching happens by exact ID first, then by unique label/type match. Ambiguous or missing matches become warnings.
- DSL form layout is a first-class structure. It preserves row order, cells per row, field order inside cells, cell span where available, and detail table row placement.
- Layout readback verifies row/cell structure at a structural level, not pixel styling.
- The executor does not attempt to replicate source CSS, fonts, colors, borders, exact widths, or complex old HTML nesting.
- Each field and detail column must carry target MK component metadata before execution.
- The form payload writer maps DSL fields and layout into NewOA `sys-xform` designer configuration.
- The workflow translator parses `LbpmProcessDefinition XML` into a DAG before execution.
- Workflow DSL preserves process metadata, nodes, edges, topological order, node attributes, edge attributes, and node definitions.
- The workflow payload writer generates a NewOA/MK-renderable minimal graph and stores source node/edge information in extension/audit fields.
- Workflow node type mapping is conservative: start to start event, end to end event, manual/approval/task-like nodes to manual task, branch/gateway-like nodes to exclusive gateway, and unknown nodes to manual task with warning.
- Workflow edges become sequence flows. Source conditions are preserved as text but are not guaranteed to become executable NewOA condition expressions in the first version.
- The first version targets designer visibility and structural review, not complete runtime approval behavior.
- Small pure payload-building or readback ideas may be extracted from the v1 knowledge base, but v2 must not port v1 browser executors, planners, batch logic, or script injection framework.
- The executor should be split into narrow modules for NewOA client/auth, form payload mapping, workflow payload mapping, readback verification, and execution orchestration.
- CLI remains thin and delegates to module interfaces.

## Testing Decisions

- The highest-value test seam is the route-validation seam: source XML translates to DSL, DSL validates and dry-runs, and DSL executes through a fake NewOA client into a readback report.
- Default tests must not access NewOA or any network endpoint.
- Executor tests use a fake client that records login/add/get/update calls and returns controlled template details.
- Safety tests assert that missing confirmation, missing category, missing credentials, invalid base URL, and invalid DSL block before login.
- Translator tests cover designer-first field extraction from `fdDesignerHtml`.
- Translator tests cover cases where designer control IDs and metadata IDs differ, ensuring canonical field IDs come from designer controls and metadata IDs are preserved separately.
- Translator tests cover layout extraction: row order, cell count per row, field order, colspan, and detail table row placement.
- DSL schema tests validate that form layout references known fields and that invalid layout references fail validation.
- Dry-run tests include layout and workflow summaries, not only flat field counts.
- Workflow translator tests validate DAG nodes, edges, topological order, and preservation of source attributes.
- Form payload tests verify external behavior by summarizing generated/readback controls rather than asserting every internal JSON detail.
- Readback tests treat structural loss as failure: missing `fdId`, unreadable template, field count mismatch, component mismatch, detail table mismatch, workflow node mismatch, workflow edge mismatch, condition edge mismatch, and empty or invalid workflow content.
- Readback tests treat semantic gaps as warnings: styling differences, node coordinates, handler/assignee incompleteness, condition expression conversion gaps, and advanced node attributes.
- CLI tests verify argument and environment behavior without printing secrets.
- A real NewOA SIT smoke test may exist behind explicit environment flags, but it must not run in default `npm test`.
- Prior art in the repo includes route-validation translator tests, DSL validation tests, dry-run tests, and the accepted ADR that defines the single-template write/readback milestone.

## Out of Scope

- Production writes.
- Updating existing NewOA templates.
- Deleting or cleaning up test templates.
- Publishing templates.
- Batch execution.
- Automatic category creation or category path matching.
- Browser login.
- Browser-based designer writing.
- Client-side plaintext password encryption.
- Frontend/workbench UI.
- PI/Agent execution.
- Broad v1 module porting.
- Full source HTML visual fidelity.
- Full NewOA condition expression conversion.
- Complete runtime handler, role, position, or assignee behavior.
- Complete advanced workflow node property mapping.
- Numbering, form rules, display rules, and publication workflow unless covered by a later PRD.
- Source formats outside the current XML route-validation scope.

## Further Notes

- Terminology must describe the source side as source XML, SysFormTemplate XML, or LbpmProcessDefinition XML; use NewOA/MK for the target system.
- The current ADR says the first success condition is one real source XML reaching a verified `MK_TEST_` template through DSL, dry-run, API write, and readback.
- The current repository did not expose a configured issue tracker directory or triage label system. This PRD is published as a repository document and marked `ready-for-agent`.
- The existing worktree contains unrelated local changes and generated fixtures. This PRD does not require reverting them.
