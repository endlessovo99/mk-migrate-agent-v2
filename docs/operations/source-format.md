# Source Format: Paired KmReview XML

The v2 route-validation source format is either:

- A single `*_SysFormTemplate.xml` file for form-only translation.
- A directory containing exactly one `*_SysFormTemplate.xml` file and exactly one `*_LbpmProcessDefinition.xml` file for form plus workflow translation.

An optional `*_KmReviewTemplate.xml` may sit alongside the paired form and workflow files. When present, its root `fdName` is the authoritative business template name used by Source Draft and DSL. `--template-name` still overrides that value. Without either source, name resolution falls back through the root SysFormTemplate `fdName`, a designer title, and finally the source filename.

The companion may recover otherwise-missing static workflow person source identity evidence only when its root `fdId` exists and exactly equals both `SysFormTemplate.fdModelId` and `LbpmProcessDefinition.templateId`. Intake reads records only from these direct root containers: `docCreator`, `docAlteror`, `docRelevantDept`, `fdFeedback`, `authAllEditors`, `authReaders`, `authEditors`, `authAllReaders`, and `authTmpReaders`. Each record must have `fdOrgType = 8`, the exact `SysOrgPerson` class, and non-empty `fdId` and `fdLoginName` values; other organization types remain outside this route.

Recovery is all-or-nothing per handler list. `handlerIds` and `handlerNames` must have the same number of non-empty positional slots, every ID must occur in an allowed companion container, and every record for a repeated `fdId` must be valid and agree on organization type, class, parent, login name, and name, including whether optional properties are present. Across the workflow, one handler fdId must always have one handler name; a conflicting name invalidates every involved list. A companion without a root `fdId`, an invalid duplicate, a partial handler list, a positional gap, or any identity conflict leaves the original unstructured handler attributes unchanged. Recovered Source Draft handler entities carry `evidenceSource = "kmReviewTemplate.rootHashMap"`. This is source provenance only: it does not select or validate a NewOA target, and the Executor still requires normal unique resolution or an explicitly validated participant override.

`SysFormTemplate.xml` is a Java XMLDecoder export for `com.landray.kmss.sys.xform.base.model.SysFormTemplate`. The adapter reads:

- `fdId`
- `fdTemplateEdition`
- `fdModelName`
- `fdModelId`
- `fdDesignerHtml`
- `fdMetadataXml`

Only direct `put` entries on the outermost root `java.util.HashMap` are current template data. Nested creator objects, lists, and historical template maps are never searched or used as fallback values.

`fdDesignerHtml` is the primary source for visible field controls and row/column layout. `fdMetadataXml` enriches designer controls with type, required state, options, organization-field metadata, and detail-table columns. A metadata-backed visibility-hidden main field is preserved as `source-draft.form.dataFields[]` and becomes `form.fields[].dataOnly = true`: it is stored with `fdDisplay = false`, remains available to `MKXFORM.getValue/setValue`, and must never appear in `mkTree` or a control-event target. A hard-hidden designer control, identified by an explicit hidden type or hidden-input evidence, is also preserved as a stored field with `sourceProps.hardHidden = true`; it is emitted as native `xform-hidden`, placed after visible fields, and excluded from layout while retaining its source references and script/form-rule relationships. Designer-only hard-hidden controls are therefore materialized when their identity is deterministic; raw row markers remain layout/script infrastructure rather than fields.

A person address whose `onChange` copies `fdLoginName` or `fdNo` through `Data_GetOrgPersonBeanNameByKey` onto one ordinary text field maps to `sysorg.getPersonByPersonId` plus `MKXFORM.setValue`. The same mapping also accepts an immediately preceding `window` load listener that repeats that lookup for the same address field. Unrelated load prefixes, extra address bindings, or missing target fields stay review-required.

Field names and visible captions are separate facts. When independent adjacent text remains in the layout, an unconditional, unique `xform:rtf`, `xform:textarea`, or `xform:xtext` rendering in the same `fdDisplayJsp` row can establish that the editor does not add its own title. Intake records that evidence in `sourceProps.layoutCell`; mapping emits `props.hiddenLabel` without changing the field name or removing the independent text. A bound caption that occupies its own title cell is the same case, including captions shared by several controls: the caption stays in layout as a description, and bound editors hide their native titles when the target component supports `hiddenLabel` so the source title|value columns remain. Captions that share a cell with their bound control still fold into the field title. A designer control that explicitly unbinds its label and has no bind target, inline caption, or adjacent retained text is the same case: the editor subject stays as the field name and is not shown as a second title. A caption already folded into a field remains visible as that field's title. Conditional, repeated, or conflicting rendering evidence produces `source.sysform.label_visibility_unverified` rather than an inferred hide operation. Nested-table regions that keep a left-side spanning caption beside a detail table retain that caption as an independent description and keep a readable native column share for it.

Multiple controls that already occupy one source cell stay in that cell. A zero-width address selector in the same cell as its `*.name` display companion maps onto the single address control; the companion is stored, not rendered. Punctuation or unit text that is not a folded number unit remains as an inline description in that cell. The native writer keeps those references as one GridItem instead of expanding them into extra columns or nested layouts.

Unequal spans in a complete, unambiguous ordinary source row are retained in the target grid, including rows whose cells still hold more than one inline control. This ordinary-row path accepts quoted or unquoted HTML widths and pixel or percentage CSS values. Only measurements with compatible units in the row become width weights; the writer emits native `colsStyle` only when the column measurements are complete and consistent. Otherwise the source spans remain the layout evidence, without guessing missing widths. Nested-table regions retain their separate, existing projection policy.

`clean` writes a source-only `source-draft.json`. It contains source controls, detail tables, source layout rows/cells, workflow DAG nodes/edges, source attributes, and source issues. It must not contain target `componentId`, `mkType`, or `@elem/*` target identifiers.

`draft` writes a non-executable `dsl-draft.json` with `trust.level = "draft"` and `trust.executable = false`. It contains target candidates, but execution remains blocked until explicit `agent-review` produces trusted `migration.dsl.json`.

The trusted DSL form section contains both field definitions and explicit target layout:

```json
{
  "trust": {
    "level": "trusted",
    "executable": true
  },
  "form": {
    "fields": [
      {
        "id": "fd_subject",
        "title": "主题",
        "type": "text",
        "componentId": "xform-input",
        "props": {
          "required": true
        },
        "sourceProps": {
          "designerType": "inputText"
        },
        "sourceRef": "source.form.control.fd_subject"
      }
    ],
    "layout": {
      "sourceGrid": {
        "source": "fdDesignerHtml",
        "rows": []
      },
      "mkTree": [
        {
          "id": "layout.row-0",
          "componentId": "xform-flex-1-1-layout",
          "props": {
            "columns": 1
          },
          "sourceRef": "source.form.layout.row.row-0",
          "children": [
            {
              "id": "layout.row-0-cell-1",
              "refType": "field",
              "refIds": ["fd_subject"],
              "sourceRef": "source.form.layout.cell.row-0-cell-1",
              "column": 1,
              "colspan": 1
            }
          ]
        }
      ]
    }
  }
}
```

`form.layout.mkTree` is an ordered layout-node registry, not a flat list of
rendered top-level rows. A child may use `refType: "layout"` with one or more
ordered `refIds` to own a vertical stack of nested layout nodes. Nodes that are
not referenced by another layout node are native roots. Layout references must
resolve, remain acyclic, and have at most one parent; duplicate references are
invalid.

NewOA's native layout grid does not persist a grid inside a `GridItem`.
Execution therefore lowers each nested root to one native multi-row grid:
ordinary sibling cells retain their proportional region and use native
`rowSpan`/`columnSpan` across the nested stack, while nested leaf controls are
direct children of sibling `GridItem` nodes. The executor may use a
one-to-eight-column integer lattice internally to calculate exact fractional
boundaries, but it collapses unused boundaries before persistence and writes
the resulting non-uniform widths as native `colsStyle`. An internal
eight-column calculation therefore becomes five visible columns when only five
semantic width segments exist; it is not exposed as an arbitrary eight-column
designer layout. Ordinary non-nested rows retain their reviewed DSL grid. If
no exact nested calculation exists within eight internal units, the root's
original column count is retained and controls wrap inside their owned region
instead of overlapping or widening unrelated rows.

Each lowered native cell carries its complete layout ownership path from the
native root to the leaf owner. Readback compares that path, the reference type,
coordinates, and `rowSpan`; dropping an intermediate nesting level is therefore
a topology mismatch even when the visible field and final coordinates still
match.

`form.fields[].id` is the canonical designer control id from `fdDesignerHtml`. If `fdMetadataXml` uses a different id for the same title/type, the metadata id is preserved in source audit data and translation emits a warning.

Every translated form field and detail-table column must include target `componentId + props + sourceProps + sourceRef`. `props` are executable and validated against `catalogs/mk-components.v1.json`. `sourceProps` are audit-only; the executor must not consume them. Unknown props are errors. Textarea `height` is never carried into DSL or execution payloads; `maxLength` remains omitted unless explicitly present in executable `props`; `maxLength: 0` is invalid.

Static designer `readOnly=true` becomes executable `props.readOnly=true` for supported data fields and detail columns. The executor writes both native `showStatus=readOnly` on the control and non-editable add/edit field permissions. The static control state also works when draft preview has no business-instance `fieldsAuth`; explicit workflow-node permissions remain separate. Readback must prove both native representations. Agent Review cannot patch this restriction, and trust validation independently compares it with the Source Draft.

JSP scripts inside `<xform:editShow>` and `<xform:viewShow>` retain immutable execution context as `scripts.actions[].runWhen`. The only generated forms are `{ "viewStatusIn": ["add", "edit"] }` and `{ "viewStatusIn": ["view"] }`, based on verified `MKXFORM.viewStatus` runtime values. Agent review translates only the business body; the executor injects and readback-verifies the canonical guard.

When a branch reads a known scalar text control's DOM `.value`, branch provenance records `emptyText=true`: an unset source input is an empty string. Reviewed MK predicates must preserve this with `String(MKXFORM.getValue('fieldId') ?? '')` or a stable `raw == null ? '' : String(raw)` alias. Bare nullable reads, converting to a string before handling null, and falsy-value defaults are rejected. This rule does not coerce organization objects, arrays, or numeric fields. Regenerate DSL and review checkpoints with the current catalog and provenance versions; existing MK templates are not updated automatically.

MK Runtime does not execute global onLoad actions in `preview` or `design` scenes. When a window-load row rule reads a hidden bridge field written by an onChange callback, intake resolves that bridge back to the business trigger. Any visibility/required dimensions whose branch and fallback values are fully evidenced become a partial native form rule, while the residual script remains for runtime-only behavior. This gives preview the source initial state without claiming the whole callback is native-covered.

`LbpmProcessDefinition.xml` is a Java XMLDecoder export for `com.landray.kmss.sys.lbpm.engine.persistence.model.LbpmProcessDefinition`. The adapter extracts the active `fdContent` process XML, parses nodes and lines into a directed acyclic graph, preserves each node and line's original attributes, and writes the result to `workflow` in DSL.

Function validation uses `catalogs/functions.v1.json` as the versioned whitelist. Source function calls outside the catalog are emitted as source issues and become blocking errors before execution. External files passed with `--function-whitelist` are filtered through the versioned catalog.

```bash
node src/cli/main.js clean <source-dir> --out source-draft.json
node src/cli/main.js draft source-draft.json --out dsl-draft.json
node src/cli/main.js agent-review source-draft.json dsl-draft.json --out migration.dsl.json --report-out agent-review.report.json
node src/cli/main.js check execute migration.dsl.json
```

See `docs/operations/agent-review.md` for the OpenAI provider env, patch contract, warning/error behavior, and live smoke command.

Route-validation fixture:

```text
tests/fixtures/source/route-validation-lbpm/
tests/fixtures/source/route-hidden-data-field/
```

Do not add source formats outside the current XML route-validation scope while hardening this adapter.

Execution uses a configured NewOA root origin, defaulting to `https://p-sit.onewo.com`:

```bash
node src/cli/main.js execute migration.dsl.json \
  --confirm-write \
  --target-category-id '<NewOA category fdId>'
```

The CLI and live-smoke entry points automatically load `.tmp/newoa.env`; variables already exported by the caller take precedence. `--base-url` overrides `NEWOA_BASE_URL`; when neither contains a value, execution uses `https://p-sit.onewo.com`. The entry points pass the resolved value to the Executor; the Executor does not read `process.env`. The base URL must be an HTTP or HTTPS root origin. Leading/trailing whitespace and a trailing root slash are normalized, while user information, a non-root path, query, fragment, or another protocol produces `safety.base_url_invalid` before login. Domains, IP addresses, localhost, and explicit ports are allowed. The normalized origin is used for requests and execution reporting.

The executor logs in through `/data/sys-auth/login`, then uses `kmReviewTemplate/add`, `kmReviewTemplate/get`, and `kmReviewTemplate/update`. It creates a new `MK_TEST_...` draft template and does not publish, delete, update existing templates, create categories, or batch execute.

Custom origins use the same explicit confirmation, category, `MK_TEST_` naming, draft-only, and readback gates as the default origin. There is no target-host allowlist or extra confirmation for a non-SIT origin.

Temporary fallback policy: only when the exact normalized target origin is `https://p-sit.onewo.com`, `http://mkpaaspoc.shanghai-electric.com`, or `http://oa-dev.shanghai-electric.com:8088`, source workflow participants that resolve as `not_found` or whose only missing lookup evidence is `sourceParentName` are replaced with type-specific current identities — person `1j5e6gebgwkw1tvw1jqie81aeqnhg302viw0`, post `1jt85eh5hw23welj9w3jq4nba1522lpc3tw0`, group `1jt85gq4uw23well7w25q9bmdj729u82tmw0`, and department/org `1jt85rk85w23welrpw2s3uh4pvsr8ru35dw0` by default. The four optional `NEWOA_FALLBACK_*_FD_ID` variables independently override those defaults; missing or blank values retain them. The organization override is shared by organization/department participants and condition organizations. The executor validates each used fdId through `getElementInfo` with a fixed expected type and writes a `workflow.participant_sit_fallback_applied` warning with replacement counts. Overrides never enable fallback behavior at any other custom origin; normal resolution, diagnostics, and blocking behavior apply there without substituting these identifiers.

Explicit participant overrides are separate from the temporary fallback policy and are opt-in per execution. Repeat `--participant-override '<sourceId>=<targetFdId>'` when more than one mapping is needed. A source ID must refer to exactly one preserved source identity; the executor validates the target through `getElementInfo`, requires an exact organization-type match, preserves the source evidence in the audit record, and emits `workflow.participant_explicit_override_applied`. Invalid or unused mappings and ambiguous or incompatible targets fail closed before template creation. Without this flag, the normal search and ambiguity behavior is unchanged.

Template authorization uses its own `--template-authorization-override '<sourceId>=<targetFdId>'` option. It never changes workflow nodes. The source ID must identify one authorization identity, and the exact current target must preserve both name and organization type. Only a missing source parent name may be repaired through this path; all other incomplete evidence remains blocking. Applied mappings emit `template.authorization_explicit_override_applied` in the execution report.

Root `nodeDefinitionHandlers` records are authoritative direct-target evidence only for static `org` selections where all of the following hold: the structured record is a fixed post (`fdOrgType = 4`), it has a valid positional index, the same-position cached `handlerIds` or `optHandlerIds` value is a non-formula literal, and the two IDs differ. The Source Draft records that structured ID as `directTargetId`; the DSL emits it as a target participant without source identity fields. This applies independently to every matching primary or optional handler, so sharing an old cached source ID across nodes does not merge their targets. If one handler position contains multiple distinct structured IDs, it remains `pending_review` and is blocked before resolution; it never guesses a target or applies a temporary fallback. The executor validates each emitted target through `getElementInfo` as exact organization type `4`, never searches the old cached ID, and never substitutes a temporary fallback when that target is missing. Structured persons, formula selections, missing positional evidence, and unchanged IDs remain source identities and use normal resolution.

An optional `workflowReferenceDir` source-intake option (CLI: `--workflow-reference-dir <initdata-dir>`) reads only `*_LbpmProcessDefinition.xml` records from a target initdata directory. It requires one exact match on source process `fdId` and template ID. For each matching static fixed-post record, it additionally requires the source and reference node IDs, primary/optional handler attribute, positional index, and cached source handler ID to match before replacing that one DSL participant with the reference target ID. It never creates an ID-wide mapping: other nodes sharing the same old source ID remain independently evidenced. No exact or more than one exact process match fails intake; an ambiguous matching reference position becomes `pending_review` and is blocked before participant lookup or fallback.
