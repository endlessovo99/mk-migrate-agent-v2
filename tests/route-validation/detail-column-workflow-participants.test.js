import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixturePath =
  "tests/fixtures/route-validation/detail-column-workflow-participants";

describe("Detail-column workflow participant Route case", () => {
  it("classifies, validates, and projects direct and role-line detail-column participants", () => {
    // This focused Route fixture normalizes the unrelated N27/N28 gateway pair
    // from all/anyone to the already-supported all/all shape. The original
    // source2 fixture remains unchanged and still blocks trust on that gateway.
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const nodesById = new Map(dslDraft.workflow.nodes.map((node) => [node.id, node]));

    assert.deepEqual(
      ["N5", "N26", "N12"].map((nodeId) => ({
        id: nodeId,
        mode: nodesById.get(nodeId).participants.mode,
        recipe: nodesById.get(nodeId).participants.recipe,
        detailTableId: nodesById.get(nodeId).participants.detailTableId,
        fieldId: nodesById.get(nodeId).participants.fieldId,
        sourceFieldId: nodesById.get(nodeId).participants.sourceFieldId
      })),
      [
        {
          id: "N5",
          mode: "field_role_line_script",
          recipe: "department_head",
          detailTableId: "fd_37970d76f84924",
          fieldId: "fd_38ecbeedc0dd52",
          sourceFieldId: "fd_38ecbeedc0dd52"
        },
        {
          id: "N26",
          mode: "form_field",
          recipe: undefined,
          detailTableId: "fd_37970d76f84924",
          fieldId: "fd_38ecbeedc0dd52",
          sourceFieldId: "fd_38ecbeedc0dd52"
        },
        {
          id: "N12",
          mode: "form_field",
          recipe: undefined,
          detailTableId: "fd_37970d76f84924",
          fieldId: "fd_38ecbeedc0dd52",
          sourceFieldId: "fd_38ecbeedc0dd52"
        }
      ]
    );

    const checked = checkDraft(dslDraft);
    assert.equal(
      checked.diagnostics.some((diagnostic) => diagnostic.level === "error"),
      false,
      JSON.stringify(checked.diagnostics)
    );

    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-07-29T00:00:00.000Z"
    });
    assert.equal(checkTrust(sourceDraft, trusted).ok, true);
    assert.equal(checkExecute(trusted).ok, true);

    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);
    const targetNodeIds = ["N5", "N26", "N12"];
    const targetReadbackErrors = readback.diagnostics.filter((diagnostic) =>
      diagnostic.level === "error" &&
      targetNodeIds.some((nodeId) => diagnostic.path.includes(`/nodes/${nodeId}/`))
    );
    assert.deepEqual(targetReadbackErrors, []);

    const workflow = JSON.parse(
      prepared.update.mechanisms.lbpmTemplate[0].fdContent
    );
    for (const nodeId of targetNodeIds) {
      const node = workflow.elements.find((element) => element.id === nodeId);
      const ruleKey = typeof node.handlers.ruleKey === "string"
        ? JSON.parse(node.handlers.ruleKey)
        : node.handlers.ruleKey;
      const variableId = ruleKey.script.match(/\$\{data\.([^}]+)\}/)?.[1];
      assert.equal(
        /^template-id-mk_model_fd_37970d76f84924\.fd_38ecbeedc0dd52$/
          .test(variableId),
        true,
        `${nodeId}: ${JSON.stringify(ruleKey)}`
      );
      const displayText = ruleKey.vo?.content || ruleKey.formulaName;
      assert.match(displayText, /\$内置表单\.明细表1\.负责人\$/);
    }
  });
});
