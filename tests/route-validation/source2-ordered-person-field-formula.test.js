import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { classifyWorkflowFormulaParticipant } from "../../src/translator/workflow-formula-participants.js";
import { prepareSample } from "../helpers/persistence.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

const SOURCE = "tests/fixtures/source2/16f5446970b2b2b951fbd7a45a2b45df";

describe("Source2 ordered person-field workflow formula", { concurrency: false }, () => {
  it("maps N37 to an ordered MK Script recipe without replacing either source field", () => {
    const sourceDraft = cleanSourceFile(SOURCE);
    const dslDraft = draftSourceDraft(sourceDraft);
    const node = dslDraft.workflow.nodes.find((item) => item.id === "N37");

    assert.deepEqual(node.participants, {
      mode: "script_formula",
      recipe: "ordered_main_person_fields",
      fields: [
        {
          fieldId: "fd_38335e044c482e",
          sourceFieldId: "fd_38335e044c482e"
        },
        {
          fieldId: "fd_select_person1",
          sourceFieldId: "fd_select_person1"
        }
      ],
      sourceExpression: "($fd_38335e044c482e$ ) ;$fd_select_person1$",
      sourceNameExpression: "($代报人$ ) ;$申对公报销申请人$"
    });
    assert.deepEqual(
      node.participants.fields.map(({ fieldId }) => {
        const field = dslDraft.form.fields.find((item) => item.id === fieldId);
        return {
          componentId: field?.componentId,
          orgTypes: field?.props?.orgTypes
        };
      }),
      [
        { componentId: "xform-address", orgTypes: ["ORG_TYPE_PERSON"] },
        { componentId: "xform-address", orgTypes: ["ORG_TYPE_PERSON"] }
      ]
    );
    assert.equal(node.translationStatus, "executable");

    const draftCheck = checkDraft(dslDraft);
    assert.equal(
      draftCheck.diagnostics.some((diagnostic) => diagnostic.level === "error"),
      false,
      JSON.stringify(draftCheck.diagnostics)
    );
    const trusted = sampleTrustedDsl({
      template: dslDraft.template,
      form: dslDraft.form,
      workflow: dslDraft.workflow,
      review: {
        warnings: dslDraft.review?.warnings || [],
        decisions: []
      }
    });
    assert.equal(checkExecute(trusted).ok, true);

    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);
    assert.deepEqual(
      readback.diagnostics.filter((diagnostic) =>
        diagnostic.level === "error" &&
        diagnostic.path.includes("/nodes/N37/")
      ),
      []
    );
    const workflow = JSON.parse(prepared.update.mechanisms.lbpmTemplate[0].fdContent);
    const nativeNode = workflow.elements.find((element) => element.id === "N37");
    const ruleKey = JSON.parse(nativeNode.handlers.ruleKey);
    assert.match(
      ruleKey.script,
      /\$\{data\.template-id-fd_38335e044c482e\}.*\$\{data\.template-id-fd_select_person1\}/
    );
    assert.match(
      ruleKey.vo.content,
      /\$内置表单\.代报人\$.*\$内置表单\.申请人\$/
    );
  });

  it("does not broaden the recipe to two unparenthesized field references", () => {
    assert.equal(
      classifyWorkflowFormulaParticipant({
        handlerSelectType: "formula",
        handlerIds: "$fd_proxy$;$fd_applicant$",
        handlerNames: "$代报人$;$申请人$"
      }).mode,
      "unmapped_formula"
    );
  });
});
