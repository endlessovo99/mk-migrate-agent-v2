import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile } from "../../src/translator/index.js";

const fixture = "tests/fixtures/route-validation/workflow-data-authority";

describe("workflow data-authority source intake", () => {
  it("matches case-variant node rights and non-prefixed ids to parsed workflow and form fields", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const node = sourceDraft.workflow.nodes.find((candidate) => candidate.id === "N2");

    assert.deepEqual(
      Object.keys(node.dataAuthority.fields).sort(),
      ["exactField", "httpCode", "resultCaption"]
    );
    assert.deepEqual(node.dataAuthority.fields.resultCaption, {
      visible: false,
      editable: false,
      required: false,
      sourceMode: "hidden",
      sourceRef: "source.form.dataAuthority.fdDesignerHtml.result_right.n2.resultCaption"
    });
    assert.deepEqual(node.dataAuthority.fields.httpCode, {
      visible: false,
      editable: false,
      required: false,
      sourceMode: "hidden",
      sourceRef: "source.form.dataAuthority.fdDesignerHtml.result_right.n2.httpCode"
    });
    assert.deepEqual(node.dataAuthority.fields.exactField, {
      visible: false,
      editable: false,
      required: false,
      sourceMode: "hidden",
      sourceRef: "source.form.dataAuthority.fdDesignerHtml.result_right.n2.exactField"
    });
  });

  it("reports orphan nodes, unresolved fields, and conservatively resolved case conflicts", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const orphan = sourceDraft.issues.find((issue) => issue.code === "source.form_right.node_missing");
    const unresolved = sourceDraft.issues.find((issue) => issue.code === "source.form_right.fields_unresolved");

    assert.equal(orphan.level, "warning");
    assert.equal(orphan.evidence.nodeId, "n404");
    assert.deepEqual(orphan.evidence.sourceRefs, [
      "source.form.dataAuthority.fdDesignerHtml.result_right.n404.resultCaption",
      "source.form.dataAuthority.fdDesignerHtml.result_right.n404.httpCode",
      "source.form.dataAuthority.fdDesignerHtml.result_right.n404.exactField"
    ]);
    assert.equal(unresolved.level, "warning");
    assert.deepEqual(unresolved.evidence, {
      sectionId: "empty_right",
      nodeIds: ["N2"],
      candidateFieldIds: ["designer_helper"],
      sourceRef: "source.form.dataAuthority.fdDesignerHtml.empty_right"
    });
    const conflict = sourceDraft.issues.find(
      (issue) => issue.code === "source.form_right.case_variant_conflict"
    );
    assert.equal(conflict.level, "warning");
    assert.deepEqual(conflict.evidence, {
      nodeId: "N2",
      fieldId: "exactField",
      selectedNodeId: "n2",
      discardedNodeId: "N2",
      modes: ["hidden", "edit"],
      sourceRefs: [
        "source.form.dataAuthority.fdDesignerHtml.result_right.n2.exactField",
        "source.form.dataAuthority.fdDesignerHtml.exact_right.N2.exactField"
      ]
    });
  });
});
