import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyFieldIdMapToForm,
  applyFieldIdMapToScripts,
  applyFieldIdMapToWorkflow,
  buildFieldIdMap,
  MK_FIELD_ID_MAX_LENGTH
} from "../../src/translator/field-id-remap.js";
import {
  classifyWorkflowFormulaParticipant,
  inspectWorkflowFormulaProvenance
} from "../../src/translator/workflow-formula-participants.js";

describe("field-id-remap", () => {
  it("shortens detail table and column ids over the MK limit and remaps references", () => {
    const form = {
      fields: [
        { id: "fd_ok", title: "短字段", type: "text" },
        {
          id: "fd_accommodationx_tax_detail",
          title: "住宿费进项税明细表",
          type: "detailTable",
          columns: [
            { id: "fd_accommodationx_tax_account", title: "进项税科目", type: "singleSelect" },
            { id: "fd_accommodationx_tax_amount", title: "住宿费进项税", type: "number" }
          ]
        }
      ],
      layout: {
        mkTree: [{
          id: "layout.row-1",
          children: [{
            id: "layout.cell-1",
            refIds: ["fd_accommodationx_tax_detail", "fd_ok"]
          }]
        }]
      }
    };

    const idMap = buildFieldIdMap(form);
    assert.equal(idMap.size, 3);
    for (const shortId of idMap.values()) {
      assert.ok(shortId.length <= MK_FIELD_ID_MAX_LENGTH);
      assert.match(shortId, /^fd_[0-9a-f]+$/);
    }

    const remapped = applyFieldIdMapToForm(form, idMap);
    const detail = remapped.fields.find((field) => field.title === "住宿费进项税明细表");
    assert.equal(detail.id, idMap.get("fd_accommodationx_tax_detail"));
    assert.equal(detail.sourceProps.originalId, "fd_accommodationx_tax_detail");
    assert.equal(detail.columns[0].id, idMap.get("fd_accommodationx_tax_account"));
    assert.deepEqual(remapped.layout.mkTree[0].children[0].refIds, [
      idMap.get("fd_accommodationx_tax_detail"),
      "fd_ok"
    ]);

    const scripts = applyFieldIdMapToScripts({
      actions: [{
        id: "detail.onChange",
        tableId: "fd_accommodationx_tax_detail",
        controlId: "fd_accommodationx_tax_amount",
        function: "function onChange(){ MKXFORM.setValue('fd_accommodationx_tax_amount', 1) }",
        coverage: { staticProps: [{ fieldId: "fd_accommodationx_tax_account", prop: "required", value: true }] }
      }]
    }, idMap);
    assert.equal(scripts.actions[0].tableId, idMap.get("fd_accommodationx_tax_detail"));
    assert.equal(scripts.actions[0].controlId, idMap.get("fd_accommodationx_tax_amount"));
    assert.match(scripts.actions[0].function, new RegExp(idMap.get("fd_accommodationx_tax_amount")));
    assert.equal(scripts.actions[0].coverage.staticProps[0].fieldId, idMap.get("fd_accommodationx_tax_account"));

    const workflow = applyFieldIdMapToWorkflow({
      nodes: [{
        id: "N2",
        dataAuthority: {
          enabled: true,
          fields: {
            fd_accommodationx_tax_amount: { visible: true, editable: false, required: false }
          }
        },
        participants: {
          mode: "form_field",
          fieldId: "fd_accommodationx_tax_account",
          sourceFieldId: "fd_accommodationx_tax_account"
        }
      }]
    }, idMap);
    assert.deepEqual(Object.keys(workflow.nodes[0].dataAuthority.fields), [
      idMap.get("fd_accommodationx_tax_amount")
    ]);
    assert.equal(workflow.nodes[0].participants.fieldId, idMap.get("fd_accommodationx_tax_account"));
    assert.equal(workflow.nodes[0].participants.sourceFieldId, "fd_accommodationx_tax_account");
  });

  it("keeps long source formula field evidence while remapping the executable field id", () => {
    const sourceFieldId = "fd_formula_participant_field_that_exceeds_limit";
    const attributes = {
      handlerSelectType: "formula",
      handlerIds: `$${sourceFieldId}$`,
      handlerNames: "$公式审批人$"
    };
    const idMap = new Map([[sourceFieldId, "fd_1234567890abcdef"]]);
    const sourceDraft = {
      form: {
        controls: [{ id: sourceFieldId, sourceRef: "source.form.control.long-formula-field" }]
      },
      workflow: {
        nodes: [{ id: "N2", sourceRef: "source.workflow.node.N2", attributes }]
      }
    };
    const workflow = applyFieldIdMapToWorkflow({
      nodes: [{
        id: "N2",
        sourceRef: "source.workflow.node.N2",
        attributes,
        participants: classifyWorkflowFormulaParticipant(attributes)
      }]
    }, idMap);

    assert.equal(workflow.nodes[0].participants.fieldId, "fd_1234567890abcdef");
    assert.equal(workflow.nodes[0].participants.sourceFieldId, sourceFieldId);
    const form = applyFieldIdMapToForm({
      fields: [{
        id: sourceFieldId,
        title: "公式审批人",
        type: "text",
        sourceRef: "source.form.control.long-formula-field"
      }]
    }, idMap);
    assert.equal(
      inspectWorkflowFormulaProvenance(sourceDraft, { form, workflow })[0].status,
      "matched"
    );
  });
});
