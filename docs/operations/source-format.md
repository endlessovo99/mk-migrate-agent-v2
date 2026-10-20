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

Field names and visible captions are separate facts. When independent adjacent text remains in the source layout, an unconditional, unique `xform:rtf`, `xform:textarea`, or `xform:xtext` rendering in the same `fdDisplayJsp` row can establish that the source editor does not add its own title. Intake records that evidence in `sourceProps.layoutCell` and keeps the caption and source grid intact.

The semantic mapper folds a plain caption into a native field title when a unique binding or verified runtime relationship establishes one owner in the adjacent cell of the same row. `sourceProps.staticCaptionFact` records static, unique, unguarded source text; `sourceProps.foldedCaption` records the consumed caption identity and both source cells. The native field retains its ID, type, permissions, required state, defaults and events. Its title becomes the visible caption, its intrinsic label is shown, and its cell occupies the original caption-plus-value region. Source item widths remain evidence; a fixed-pixel combined desktop wrapper reserves the existing native title/padding space without changing the editor's width or introducing an auto-width column policy.

Shared captions (including hidden or data-only owners), table headers, spanning titles, mixed content cells, independent permissions, styled/link/clickable captions, and script-referenced captions remain separate. Unknown DOM effects, stylesheets or conditional markup cannot establish a new fold. Retained captions continue to hide their editors' duplicate intrinsic titles. Existing same-cell caption folding is unchanged. A designer control explicitly unbinding its label with no bind target, inline caption or adjacent text still keeps its internal subject hidden. Source-derived trust and agent-patch checks verify each fold, complete field semantics, source grid and merged region; readback checks the actual native title and visibility on desktop and mobile. These rules affect newly translated DSL only and do not authorize changes to existing NewOA templates.

Multiple controls that already occupy one source cell stay in that cell. A positive-width, visible `*.name` input with its own active label binding remains a visible text input beside its zero-width address selector; its required state stays on the input. Other display companions retain the single-address-control mapping and are stored without rendering. Punctuation or unit text that is not a folded number unit remains as an inline description in that cell. The native writer keeps those references as one GridItem. Explicit DSL `contentFlow` uses native flex containers to preserve source line breaks, wrapping, and item widths. A `keepInline` group without `contentFlow` uses a native `xform-row` inside that GridItem: short descriptions get a small column share, while editors share the remaining width. An inner horizontal container is necessary because NewOA wraps GridItem contents in a vertical receiver. Readback checks the chosen layout contract as well as field references; lost horizontal layout fails verification.

Unequal spans in a complete, unambiguous source row are retained in the target grid, including nested standard-table rows and cells holding multiple inline controls. Ordinary rows accept quoted or unquoted HTML widths and pixel or percentage CSS values. Only measurements with compatible units in the row become width weights; the writer emits native `colsStyle` for an ordinary row only when its column measurements are complete and consistent. Otherwise its source spans remain the layout evidence, without guessing missing widths.

A nested static table retains its description-only header when at least two column headings align with inputs in a body row. A blank corner and later merged explanation rows are allowed when their column extents agree. Header captions remain separate controls; the input-plus-unit cells and later `colspan` values keep their source positions. Two-column label/value forms and mixed input/header rows do not establish this header pattern.

A headerless nested title/value row can retain its independent caption when the adjacent editor has inactive label binding, even if a stale binding ID points elsewhere. Recovery requires a unique rendered JSP editor and the same visible caption in an unconditional source row. An `xform:right` permission wrapper does not add an editor title: its permissions remain intact while the retained caption supplies the visible title and the native editor subject is hidden. This also applies to retained external permission captions beside text and radio editors. Conditional rows and explicit `showLabel` renderers do not establish this evidence.

For source flow input/radio items with positive pixel widths and independently hidden titles, desktop persistence uses compact native field padding, retaining space for required markers. A short unit beside an editor at most 100px wide receives compact spacing. Source-width column projection reserves a larger minimum weight for tables containing narrow inline items, accounting for both native wrappers in the classic theme. Source control widths, explicit line breaks, field types, and mobile padding remain intact; readback verifies the native padding and column widths as well as the content flow.

Single-choice and multiple-choice controls can fold a same-cell “其他” caption and text companion into one native other option. An existing numbered or parenthesized other label, including “其他附件”, establishes the same relation when the adjacent text field's title matches that choice group. Intake retains the original option value and label as source evidence; the DSL mapper replaces the option with `label: "其他"`, `value: "other_"`, `type: "other"`, and `isRequired: true`. The companion remains stored as a data-only field and is removed from the visible layout and unconditional required checks. Main fields and detail columns follow the same mapping. An ordinary other option without a text companion, unrelated adjacent text, or multiple competing other options does not establish this relation.

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
direct children of sibling `GridItem` nodes. The executor computes an exact
common integer denominator for nested column boundaries, collapses unused
boundaries, and writes their proportional widths as native `colsStyle`.
Flattening may need more than eight native columns: a section caption beside
an eight-column table needs nine. The retained native renderer in
`tests/fixtures/executor/persistence/layout-grid-runtime/` accepts those tracks
and merged-cell boundaries without clamping. The catalog limit still applies
to each individual DSL node, not to the flattened native grid. Inexact numeric
coordinates fail rather than silently reflowing a source row. Ordinary
non-nested rows retain their reviewed DSL grid. Renderer replay and fake
readback do not establish live server normalization or browser acceptance.

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

Source department identities (`sourceOrgType = 2`) with a non-empty `sourceId` are resolved by exact current `fdId` before name matching, in both workflow participants and template authorization. Explicit caller mappings retain precedence. The exact response must contain one matching department with `fdIsAvailable: true`; duplicate, malformed, wrong-ID, wrong-type, unavailable, or failed responses block before template creation. A conflicting source name or a conflicting known parent also blocks. A source parent is not required for a valid exact-ID result. Only an empty successful exact lookup may continue through the existing name/parent/type and scoped fallback policy; missing search capability remains blocking if that continuation is needed. Execution reports retain `departmentIdResolutions` with source evidence, target availability and all reference paths. This rule does not change other organization types or condition-organization name resolution.

Temporary fallback policy: only when the exact normalized target origin appears in the [temporary fallback origin list](../adr/0006-use-a-temporary-sit-participant-fallback.md), including `https://oaqas.shanghai-electric.com`, source workflow participants that resolve as `not_found` or whose only missing lookup evidence is `sourceParentName` are replaced with type-specific current identities — person `1j5e6gebgwkw1tvw1jqie81aeqnhg302viw0`, post `1jt85eh5hw23welj9w3jq4nba1522lpc3tw0`, group `1jt85gq4uw23well7w25q9bmdj729u82tmw0`, and department/org `1jt85rk85w23welrpw2s3uh4pvsr8ru35dw0` by default. The four optional `NEWOA_FALLBACK_*_FD_ID` variables independently override those defaults; missing or blank values retain them. The organization override is shared by organization/department participants and condition organizations. The executor validates each used fdId through `getElementInfo` with a fixed expected type and writes a `workflow.participant_sit_fallback_applied` warning with replacement counts. Overrides never enable fallback behavior at any other custom origin; normal resolution, diagnostics, and blocking behavior apply there without substituting these identifiers.

Explicit participant overrides are separate from the temporary fallback policy and are opt-in per execution. Repeat `--participant-override '<sourceId>=<targetFdId>'` when more than one mapping is needed. A source ID must refer to exactly one preserved source identity; the executor validates the target through `getElementInfo`, requires an exact organization-type match, preserves the source evidence in the audit record, and emits `workflow.participant_explicit_override_applied`. Invalid or unused mappings and ambiguous or incompatible targets fail closed before template creation. Without this flag, the normal search and ambiguity behavior is unchanged.

Template authorization uses its own `--template-authorization-override '<sourceId>=<targetFdId>'` option. It never changes workflow nodes. The source ID must identify one authorization identity, and the exact current target must preserve both name and organization type. Only a missing source parent name may be repaired through this path; all other incomplete evidence remains blocking. Applied mappings emit `template.authorization_explicit_override_applied` in the execution report.

Root `nodeDefinitionHandlers` records are authoritative direct-target evidence only for static `org` selections where all of the following hold: the structured record is a fixed post (`fdOrgType = 4`), it has a valid positional index, the same-position cached `handlerIds` or `optHandlerIds` value is a non-formula literal, and the two IDs differ. The Source Draft records that structured ID as `directTargetId`; the DSL emits it as a target participant without source identity fields. This applies independently to every matching primary or optional handler, so sharing an old cached source ID across nodes does not merge their targets. If one handler position contains multiple distinct structured IDs, it remains `pending_review` and is blocked before resolution; it never guesses a target or applies a temporary fallback. The executor validates each emitted target through `getElementInfo` as exact organization type `4`, never searches the old cached ID, and never substitutes a temporary fallback when that target is missing. Structured persons, formula selections, missing positional evidence, and unchanged IDs remain source identities and use normal resolution.

An optional `workflowReferenceDir` source-intake option (CLI: `--workflow-reference-dir <initdata-dir>`) reads only `*_LbpmProcessDefinition.xml` records from a target initdata directory. It requires one exact match on source process `fdId` and template ID. For each matching static fixed-post record, it additionally requires the source and reference node IDs, primary/optional handler attribute, positional index, and cached source handler ID to match before replacing that one DSL participant with the reference target ID. It never creates an ID-wide mapping: other nodes sharing the same old source ID remain independently evidenced. No exact or more than one exact process match fails intake; an ambiguous matching reference position becomes `pending_review` and is blocked before participant lookup or fallback.

Date/time controls also preserve source-backed `hiddenLabel` when an independent caption already labels their source cell, including begin/end dates sharing a period caption. This uses the existing native desktop/mobile label contract; it does not hide standalone date labels without source evidence.

Numeric controls preserve source-backed `hiddenLabel` for independent/shared captions, including salary-range inputs and headcount. Numeric unit text (such as 到) continues to use the native localized number format, independently of title visibility.

Detail header extraction excludes source footer rows (`noFoot`), so a same-column aggregate caption such as 合计 cannot invalidate the visible header and expose an internal metadata label. Footer calculations remain independently mapped.

Unbound address controls with stale caption IDs may hide their internal labels only when the rendered JSP has a unique unconditional `xform:address` with matching `.id`/`.name` property pairs and the existing adjacent caption is retained in that row. Existing conditional/showLabel guards still apply; defaults and organization types are preserved.

Attachment controls preserve source-backed hiddenLabel when an independent source caption already labels the field, using the same desktop/mobile wrapper settings as other input controls. Attachment upload limits and defaults remain unchanged.

For source-backed complementary load visibility bridges, native rules own the row show/hide behavior derived from the editable selector. Deterministic load handlers record that native coverage and retain other effects, avoiding stale hidden-helper values overriding the rule. Delegation requires the same source script and target plus explicit opposing visible effects in both native branches; incomplete bridges retain script behavior.

A positive-width `.name` companion with inactive title binding remains a visible required input when a unique unconditional JSP xtext rendering and retained adjacent caption independently prove its presentation. The xtext property preserves the `.name` suffix for this evidence; without it the existing data-only fallback remains.
