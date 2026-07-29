import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { classifyWorkflowFormulaParticipant } from "../../src/translator/workflow-formula-participants.js";
import { prepareSample } from "../helpers/persistence.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { resolveRouteFixture } from "./fixture.js";

const SOURCE_EXPRESSION = "String deptCodes = $fd_department_code$; return $部门领导.根据部门编号获取部门领导$(deptCodes);";
const SOURCE_NAME_EXPRESSION = "String deptCodes = $WBS号所属部门代码$; return $部门领导.根据部门编号获取部门领导$(deptCodes);";

describe("Route-validation department-leader alias formula", { concurrency: false }, () => {
  it("normalizes an exact local field alias to the existing department-leader participant", () => {
    const draft = departmentLeaderAliasDraft();
    const node = draft.workflow.nodes.find((item) => item.id === "N2");

    assert.deepEqual(node.participants, {
      mode: "dept_leader_by_no",
      fieldId: "fd_department_code",
      sourceFieldId: "fd_department_code",
      fieldTitle: "WBS号所属部门代码",
      sourceExpression: SOURCE_EXPRESSION,
      sourceNameExpression: SOURCE_NAME_EXPRESSION
    });
    assert.equal(node.translationStatus, "executable");
    assert.equal(
      draft.form.fields.find((field) => field.id === "fd_department_code")?.dataOnly,
      true
    );
  });

  it("projects only the canonical Eval formula and verifies its persisted display content", () => {
    const draft = departmentLeaderAliasDraft();
    const draftCheck = checkDraft(draft);
    assert.equal(
      draftCheck.diagnostics.some((diagnostic) => diagnostic.level === "error"),
      false,
      JSON.stringify(draftCheck.diagnostics)
    );
    const trusted = sampleTrustedDsl({
      template: draft.template,
      form: draft.form,
      workflow: draft.workflow,
      review: {
        warnings: draft.review?.warnings || [],
        decisions: []
      }
    });
    assert.equal(checkExecute(trusted).ok, true);

    const prepared = prepareSample(trusted);
    const workflow = JSON.parse(prepared.update.mechanisms.lbpmTemplate[0].fdContent);
    const node = workflow.elements.find((element) => element.id === "N2");
    const ruleKey = typeof node.handlers.ruleKey === "string"
      ? JSON.parse(node.handlers.ruleKey)
      : node.handlers.ruleKey;

    assert.equal(ruleKey.type, "Eval");
    assert.equal(
      ruleKey.script,
      "$部门领导.根据部门编号获取部门领导$(${data.template-id-fd_department_code})"
    );
    assert.deepEqual(ruleKey.varIds, ["template-id-fd_department_code"]);
    assert.equal(
      ruleKey.vo.content,
      "$部门领导.根据部门编号获取部门领导$($WBS号所属部门代码$)"
    );
    assert.equal(node.handlers.ruleName, ruleKey.vo.content);
    assert.equal(JSON.stringify(node).includes("String deptCodes"), false);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });

  it("keeps transformed, mismatched, and multi-statement aliases fail-closed", () => {
    const unsupported = [
      {
        handlerIds: SOURCE_EXPRESSION,
        handlerNames: "String departmentCodes = $WBS号所属部门代码$; return $部门领导.根据部门编号获取部门领导$(departmentCodes);"
      },
      {
        handlerIds: "String deptCodes = $fd_department_code$; return $部门领导.根据部门编号获取部门领导$(otherCodes);",
        handlerNames: SOURCE_NAME_EXPRESSION
      },
      {
        handlerIds: "String deptCodes = $fd_department_code$; deptCodes = \"fallback\"; return $部门领导.根据部门编号获取部门领导$(deptCodes);",
        handlerNames: SOURCE_NAME_EXPRESSION
      },
      {
        handlerIds: "String deptCodes = $fd_department_code$ + \"01\"; return $部门领导.根据部门编号获取部门领导$(deptCodes);",
        handlerNames: SOURCE_NAME_EXPRESSION
      },
      {
        handlerIds: "String deptCodes = $fd_department_code$; log.info(deptCodes); return $部门领导.根据部门编号获取部门领导$(deptCodes);",
        handlerNames: SOURCE_NAME_EXPRESSION
      },
      {
        handlerIds: "List deptCodes = $fd_department_code$; return $部门领导.根据部门编号获取部门领导$(deptCodes.get(0));",
        handlerNames: "List deptCodes = $WBS号所属部门代码$; return $部门领导.根据部门编号获取部门领导$(deptCodes.get(0));"
      }
    ];

    for (const attributes of unsupported) {
      assert.equal(
        classifyWorkflowFormulaParticipant({
          handlerSelectType: "formula",
          ...attributes
        }).mode,
        "unmapped_formula"
      );
    }
  });
});

function departmentLeaderAliasDraft() {
  const fixturePath = resolveRouteFixture({
    kind: "paired",
    relativePath: "department-leader-alias"
  });
  return draftSourceDraft(cleanSourceFile(fixturePath));
}
