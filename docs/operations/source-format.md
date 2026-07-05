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

`fdDesignerHtml` is the primary source for visible field controls and row/column layout. `fdMetadataXml` enriches designer controls with type, required state, options, organization-field metadata, and detail-table columns. Metadata-only fields do not create visible MK controls in the first executor version.

The DSL form section contains both field definitions and layout:

```json
{
  "form": {
    "fields": [
      {
        "id": "fd_subject",
        "title": "主题",
        "type": "text"
      }
    ],
    "layout": {
      "source": "fdDesignerHtml",
      "rows": [
        {
          "id": "row-0",
          "cells": [
            {
              "id": "row-0-cell-1",
              "fieldId": "fd_subject",
              "fieldIds": ["fd_subject"],
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

`form.fields[].id` is the canonical designer control id from `fdDesignerHtml`. If `fdMetadataXml` uses a different id for the same title/type, the metadata id is preserved under `field.source.metadataId` and translation emits a warning.

Every translated form field and detail-table column must include target MK component metadata:

```json
{
  "id": "fd_subject",
  "title": "主题",
  "type": "text",
  "mk": {
    "component": "xform-input",
    "group": "basic",
    "itemTid": "xform-ide-sidebar-tabPane-control-@elem-xform-input",
    "sourceComponent": "@elem/xform-input"
  }
}
```

`type` is the migration DSL semantic type. `mk.component` and `mk.itemTid` are the target NewOA/MK component identifiers consumed by execution.

`LbpmProcessDefinition.xml` is a Java XMLDecoder export for `com.landray.kmss.sys.lbpm.engine.persistence.model.LbpmProcessDefinition`. The adapter extracts the active `fdContent` process XML, parses nodes and lines into a directed acyclic graph, preserves each node and line's original attributes, and writes the result to `workflow` in DSL.

When translating SysForm designer scripts, provide the Shanghai Electric function whitelist workbook:

```bash
node src/cli/main.js translate <source-dir> \
  --function-whitelist /path/to/上海电气使用函数清单与MK函数对应.xls \
  --out dsl.json
```

`MK_FUNCTION_WHITELIST_PATH` can be used instead of the CLI flag. The whitelist must contain `函数名` and `对应的MK函数` columns. Source function calls outside the whitelist are emitted as `review.errors` and make DSL validation fail.

Route-validation fixture:

```text
tests/fixtures/source/route-validation-lbpm/
```

Do not add source formats outside the current XML route-validation scope while hardening this adapter.

Execution uses the NewOA SIT API route only:

```bash
NEWOA_USERNAME=01025344 \
NEWOA_ENCRYPTED_PASSWORD='...' \
node src/cli/main.js execute dsl.json \
  --confirm-write \
  --target-category-id '<NewOA category fdId>'
```

The executor logs in through `/data/sys-auth/login`, then uses `kmReviewTemplate/add`, `kmReviewTemplate/get`, and `kmReviewTemplate/update`. It creates a new `MK_TEST_...` draft template and does not publish, delete, update existing templates, create categories, or batch execute.
