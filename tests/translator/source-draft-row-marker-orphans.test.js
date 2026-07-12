import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sourceDraftFromLegacyDsl } from "../../src/translator/source-draft.js";

describe("Source Draft script row-marker reconciliation", () => {
  it("warns once per source script with unique orphan markers and call counts", () => {
    const sourceDraft = sourceDraftFromLegacyDsl({
      source: { fdModelId: "model-1" },
      template: { name: "row-marker-reconciliation" },
      form: {
        fields: [],
        layout: {
          rows: [
            {
              id: "invoice-row-10",
              sourceMarkers: ["invoice_row10"],
              cells: []
            }
          ]
        }
      },
      scripts: {
        sources: [
          {
            id: "special-invoice-fields",
            sourceRef: "source.form.jsp.special-invoice-fields",
            javascript: `
              common_dom_row_set_show_required_reset("invoice_row10", true, true, false);
              common_dom_row_set_show_required_reset("invoice_row11", true, true, false);
              common_dom_row_set_show_required_reset("invoice_row11", false, false, false);
              common_dom_row_set_show_required_reset("invoice_row111", true, true, false);
            `,
            semanticFacts: {
              rowMarkers: [
                { rowId: "invoice_row10", reset: false },
                { rowId: "invoice_row11", reset: false },
                { rowId: "invoice_row11", reset: false },
                { rowId: "invoice_row111", reset: false }
              ]
            }
          },
          {
            id: "resolved-only",
            sourceRef: "source.form.jsp.resolved-only",
            javascript: "common_dom_row_set_show_required_reset('invoice_row10', true, true, false);",
            semanticFacts: {
              rowMarkers: [{ rowId: "invoice_row10", reset: false }]
            }
          }
        ]
      }
    }, {
      sourcePath: "synthetic_SysFormTemplate.xml",
      sourceKind: "sysform-template-xml"
    });

    const warnings = sourceDraft.issues.filter((issue) =>
      issue.code === "source.sysform.script_row_marker_orphan_noop"
    );

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, "warning");
    assert.match(warnings[0].message, /no current source layout target/i);
    assert.equal(warnings[0].sourcePath, "/scripts/sources/0/semanticFacts/rowMarkers");
    assert.deepEqual(warnings[0].evidence, {
      sourceRef: "source.form.jsp.special-invoice-fields",
      helper: "common_dom_row_set_show_required_reset",
      markers: [
        { rowId: "invoice_row11", occurrenceCount: 2, resetValues: [false] },
        { rowId: "invoice_row111", occurrenceCount: 1, resetValues: [false] }
      ],
      proof: {
        absentFromLayout: true,
        onlyHelperTarget: true,
        resetValuesAudited: true,
        dynamicDomCreationDetected: false
      }
    });
  });

  it("does not classify orphan markers as no-ops when any safety proof is missing", () => {
    const sourceDraft = sourceDraftFromLegacyDsl({
      source: { fdModelId: "model-unsafe" },
      template: { name: "unsafe-row-markers" },
      form: { fields: [], layout: { rows: [] } },
      scripts: {
        sources: [
          {
            id: "non-helper-use",
            sourceRef: "source.form.jsp.non-helper-use",
            javascript: `
              common_dom_row_set_show_required_reset("shared_row", false, false, false);
              document.getElementById("shared_row");
            `,
            semanticFacts: { rowMarkers: [{ rowId: "shared_row", reset: false }] }
          },
          {
            id: "dynamic-dom",
            sourceRef: "source.form.jsp.dynamic-dom",
            javascript: `
              common_dom_row_set_show_required_reset("dynamic_row", false, false, false);
              document.createElement("tr");
            `,
            semanticFacts: { rowMarkers: [{ rowId: "dynamic_row", reset: false }] }
          },
          {
            id: "template-literal-use",
            sourceRef: "source.form.jsp.template-literal-use",
            javascript: "common_dom_row_set_show_required_reset('template_row', false, false, false); document.getElementById(`template_row`);",
            semanticFacts: { rowMarkers: [{ rowId: "template_row", reset: false }] }
          },
          {
            id: "insert-row",
            sourceRef: "source.form.jsp.insert-row",
            javascript: "common_dom_row_set_show_required_reset('insert_row', false, false, false); table.insertRow();",
            semanticFacts: { rowMarkers: [{ rowId: "insert_row", reset: false }] }
          },
          {
            id: "jquery-selector",
            sourceRef: "source.form.jsp.jquery-selector",
            javascript: "common_dom_row_set_show_required_reset('selector_row', false, false, false); $('#selector_row').hide();",
            semanticFacts: { rowMarkers: [{ rowId: "selector_row", reset: false }] }
          },
          {
            id: "jquery-template-html",
            sourceRef: "source.form.jsp.jquery-template-html",
            javascript: "common_dom_row_set_show_required_reset('template_html_row', false, false, false); $(`<tr>`);",
            semanticFacts: { rowMarkers: [{ rowId: "template_html_row", reset: false }] }
          },
          {
            id: "jquery-html",
            sourceRef: "source.form.jsp.jquery-html",
            javascript: "common_dom_row_set_show_required_reset('jquery_html_row', false, false, false); jQuery('<tr>');",
            semanticFacts: { rowMarkers: [{ rowId: "jquery_html_row", reset: false }] }
          },
          {
            id: "comment-only",
            sourceRef: "source.form.jsp.comment-only",
            javascript: "// common_dom_row_set_show_required_reset('comment_row', false, false, false);",
            semanticFacts: { rowMarkers: [{ rowId: "comment_row", reset: false }] }
          }
        ]
      }
    });

    assert.equal(sourceDraft.issues.some((issue) =>
      issue.code === "source.sysform.script_row_marker_orphan_noop"
    ), false);
  });

  it("audits reset-bearing helper calls as no-ops when their marker target is proven absent", () => {
    const sourceDraft = sourceDraftFromLegacyDsl({
      source: { fdModelId: "model-reset-orphan" },
      template: { name: "reset-bearing-row-marker" },
      form: { fields: [], layout: { rows: [] } },
      scripts: {
        sources: [{
          id: "reset-true",
          sourceRef: "source.form.jsp.reset-true",
          javascript: [
            "common_dom_row_set_show_required_reset('reset_row', false, false, false);",
            "common_dom_row_set_show_required_reset('reset_row', true, true, true);"
          ].join("\n"),
          semanticFacts: {
            rowMarkers: [
              { rowId: "reset_row", reset: false },
              { rowId: "reset_row", reset: true }
            ]
          }
        }]
      }
    });

    const warning = sourceDraft.issues.find((issue) =>
      issue.code === "source.sysform.script_row_marker_orphan_noop"
    );
    assert.deepEqual(warning.evidence.markers, [{
      rowId: "reset_row",
      occurrenceCount: 2,
      resetValues: [false, true]
    }]);
    assert.deepEqual(warning.evidence.proof, {
      absentFromLayout: true,
      onlyHelperTarget: true,
      resetValuesAudited: true,
      dynamicDomCreationDetected: false
    });
  });
});
