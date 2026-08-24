import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture =
  "tests/fixtures/source2/171b42a34a50edaf52458864c6a87855";

describe("field role-line MK syntax Route-validation", () => {
  it("preserves the N5 explain-role-line function and both role arguments", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-08-24T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const workflow = JSON.parse(
      prepared.update.mechanisms.lbpmTemplate[0].fdContent
    );
    const node = workflow.elements.find((element) => element.id === "N5");
    const ruleKey = JSON.parse(node.handlers.ruleKey);
    const expected =
      'return #解释角色线#($内置表单.经办人/项目经理$, "公司级部门领导", "部门领导")';
    const expectedScript =
      'return ${func.sysRole.resolveRoleLine}(${data.template-id-fd_38698f98b41f60}, "公司级部门领导", "部门领导")';

    assert.equal(node.handlers.ruleName, expected);
    assert.equal(ruleKey.vo.content, expected);
    assert.equal(ruleKey.script, expectedScript);
    const readback = prepared.verify(prepared.update);
    assert.deepEqual(
      readback.diagnostics.filter((diagnostic) =>
        diagnostic.path.includes("/nodes/N5/participants")
      ),
      []
    );

    const corrupted = structuredClone(prepared.update);
    const corruptedWorkflow = JSON.parse(
      corrupted.mechanisms.lbpmTemplate[0].fdContent
    );
    const corruptedNode = corruptedWorkflow.elements.find((element) => element.id === "N5");
    const corruptedRuleKey = JSON.parse(corruptedNode.handlers.ruleKey);
    corruptedRuleKey.script = corruptedRuleKey.script.replace(
      "sysRole.resolveRoleLine",
      "sysorg.getDepartmentHead"
    );
    corruptedNode.handlers.ruleKey = JSON.stringify(corruptedRuleKey);
    corrupted.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(corruptedWorkflow);

    const corruptedReadback = prepared.verify(corrupted);
    assert.equal(corruptedReadback.ok, false);
    assert.equal(
      corruptedReadback.diagnostics.some((diagnostic) =>
        diagnostic.path.includes("/nodes/N5/participants")
      ),
      true,
      JSON.stringify(corruptedReadback.diagnostics, null, 2)
    );
  });
});
