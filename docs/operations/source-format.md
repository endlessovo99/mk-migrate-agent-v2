# Source Format: Paired KmReview XML

The v2 route-validation source format is either:

- A single `*_SysFormTemplate.xml` file for form-only translation.
- A directory containing exactly one `*_SysFormTemplate.xml` file and exactly one `*_LbpmProcessDefinition.xml` file for form plus workflow translation.

`SysFormTemplate.xml` is a Java XMLDecoder export for `com.landray.kmss.sys.xform.base.model.SysFormTemplate`. The adapter reads:

- `fdId`
- `fdTemplateEdition`
- `fdModelName`
- `fdModelId`
- `fdDesignerHtml`
- `fdMetadataXml`

Only direct `put` entries on the outermost root `java.util.HashMap` are current template data. Nested creator objects, lists, and historical template maps are never searched or used as fallback values.

`fdDesignerHtml` is the primary source for visible field controls and row/column layout. `fdMetadataXml` enriches designer controls with type, required state, options, organization-field metadata, and detail-table columns. A metadata-backed hidden main field is preserved as `source-draft.form.dataFields[]` and becomes `form.fields[].dataOnly = true`: it is stored with `fdDisplay = false`, remains available to `MKXFORM.getValue/setValue`, and must never appear in `mkTree` or a control-event target. Designer-only hidden markers without matching metadata are not materialized.

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

`form.fields[].id` is the canonical designer control id from `fdDesignerHtml`. If `fdMetadataXml` uses a different id for the same title/type, the metadata id is preserved in source audit data and translation emits a warning.

Every translated form field and detail-table column must include target `componentId + props + sourceProps + sourceRef`. `props` are executable and validated against `catalogs/mk-components.v1.json`. `sourceProps` are audit-only; the executor must not consume them. Unknown props are errors. Textarea `height` is never carried into DSL or execution payloads; `maxLength` remains omitted unless explicitly present in executable `props`; `maxLength: 0` is invalid.

JSP scripts inside `<xform:editShow>` and `<xform:viewShow>` retain immutable execution context as `scripts.actions[].runWhen`. The only generated forms are `{ "viewStatusIn": ["add", "edit"] }` and `{ "viewStatusIn": ["view"] }`, based on verified `MKXFORM.viewStatus` runtime values. Agent review translates only the business body; the executor injects and readback-verifies the canonical guard.

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
NEWOA_USERNAME=01025344 \
NEWOA_ENCRYPTED_PASSWORD='...' \
NEWOA_BASE_URL='https://p-sit.onewo.com' \
node src/cli/main.js execute migration.dsl.json \
  --confirm-write \
  --target-category-id '<NewOA category fdId>'
```

`--base-url` overrides `NEWOA_BASE_URL`; when neither contains a value, execution uses `https://p-sit.onewo.com`. The CLI and live-smoke entry points read the environment variable and pass the resolved value to the Executor; the Executor does not read `process.env`. The base URL must be an HTTP or HTTPS root origin. Leading/trailing whitespace and a trailing root slash are normalized, while user information, a non-root path, query, fragment, or another protocol produces `safety.base_url_invalid` before login. Domains, IP addresses, localhost, and explicit ports are allowed. The normalized origin is used for requests and execution reporting.

The executor logs in through `/data/sys-auth/login`, then uses `kmReviewTemplate/add`, `kmReviewTemplate/get`, and `kmReviewTemplate/update`. It creates a new `MK_TEST_...` draft template and does not publish, delete, update existing templates, create categories, or batch execute.

Custom origins use the same explicit confirmation, category, `MK_TEST_` naming, draft-only, and readback gates as the default origin. There is no target-host allowlist or extra confirmation for a non-SIT origin.

Temporary fallback policy: only when the exact normalized target origin is `https://p-sit.onewo.com` or `http://mkpaaspoc.shanghai-electric.com`, source workflow participants that resolve as `not_found` or whose only missing lookup evidence is `sourceParentName` are replaced with type-specific current identities — person `1j5e6gebgwkw1tvw1jqie81aeqnhg302viw0`, post `1jt85eh5hw23welj9w3jq4nba1522lpc3tw0`, group `1jt85gq4uw23well7w25q9bmdj729u82tmw0`, and department/org `1jt85rk85w23welrpw2s3uh4pvsr8ru35dw0`. The executor validates each used fdId through `getElementInfo` and writes a `workflow.participant_sit_fallback_applied` warning with replacement counts. Condition-organization unresolved names use the same department fallback and are likewise limited to those origins. Neither fallback set is reused at any other custom origin; normal resolution, diagnostics, and blocking behavior apply without substituting these identifiers.
