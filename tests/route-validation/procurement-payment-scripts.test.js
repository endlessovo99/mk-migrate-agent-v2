import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixturePath = "tests/fixtures/source/1887a98750756b5ba35b02047e6a6a30";

describe("procurement payment script Route case", () => {
  it("projects post-name contains branches as native Eval formulas", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-07-28T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const workflow = JSON.parse(
      prepared.update.mechanisms.lbpmTemplate[0].fdContent
    );
    const elements = new Map(workflow.elements.map((element) => [element.id, element]));
    const cases = [
      { nodeId: "N26", edgeId: "L33", value: "财务" },
      { nodeId: "N26", edgeId: "L30", value: "外包专员" },
      { nodeId: "N47", edgeId: "L53", value: "财务" },
      { nodeId: "N47", edgeId: "L54", value: "外包" }
    ];

    for (const item of cases) {
      const node = elements.get(item.nodeId);
      const route = JSON.parse(node.conditionValue).formulas
        .find((candidate) => candidate.lineId === item.edgeId);
      const edgeFormula = JSON.parse(elements.get(item.edgeId).formula);

      assert.equal(route.mode, "formula", item.edgeId);
      assert.equal(route.formulaConfig.type, "Eval", item.edgeId);
      assert.equal(
        route.formulaConfig.script,
        `\${func.global.contains}(\${data.template-id-fd_apply_post.fdName}, ${JSON.stringify(item.value)})`,
        item.edgeId
      );
      assert.equal(
        route.formulaConfig.vo.content,
        `#字符串或字符串数组比较#($内置表单.岗位.名称$, ${JSON.stringify(item.value)})`,
        item.edgeId
      );
      assert.deepEqual(edgeFormula, route.formulaConfig, item.edgeId);
    }

    const readback = prepared.verify(prepared.update);
    assert.equal(
      readback.diagnostics.some((diagnostic) =>
        diagnostic.path === "/readback/workflow/edges/L33/condition"
      ),
      false,
      JSON.stringify(readback.diagnostics)
    );

    const mutated = structuredClone(prepared.update);
    const mutatedWorkflow = JSON.parse(
      mutated.mechanisms.lbpmTemplate[0].fdContent
    );
    const financeEdge = mutatedWorkflow.elements.find((element) => element.id === "L33");
    const financeFormula = JSON.parse(financeEdge.formula);
    financeFormula.script = financeFormula.script.replace(".fdName", "");
    financeEdge.formula = JSON.stringify(financeFormula);
    mutated.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(mutatedWorkflow);

    const rejected = prepared.verify(mutated);
    assert.equal(rejected.ok, false);
    assert.equal(
      rejected.diagnostics.some((diagnostic) =>
        diagnostic.code ===
          "readback.workflow.edge_condition_native_semantic_mismatch" &&
        diagnostic.path === "/readback/workflow/edges/L33/condition"
      ),
      true,
      JSON.stringify(rejected.diagnostics)
    );

    const unquoted = structuredClone(prepared.update);
    const unquotedWorkflow = JSON.parse(
      unquoted.mechanisms.lbpmTemplate[0].fdContent
    );
    const unquotedFinanceEdge = unquotedWorkflow.elements
      .find((element) => element.id === "L33");
    const unquotedFinanceFormula = JSON.parse(unquotedFinanceEdge.formula);
    unquotedFinanceFormula.script = unquotedFinanceFormula.script
      .replace('"财务"', "财务");
    unquotedFinanceEdge.formula = JSON.stringify(unquotedFinanceFormula);
    unquoted.mechanisms.lbpmTemplate[0].fdContent =
      JSON.stringify(unquotedWorkflow);

    const unquotedRejected = prepared.verify(unquoted);
    assert.equal(unquotedRejected.ok, false);
    assert.equal(
      unquotedRejected.diagnostics.some((diagnostic) =>
        diagnostic.code ===
          "readback.workflow.edge_condition_native_semantic_mismatch" &&
        diagnostic.path === "/readback/workflow/edges/L33/condition"
      ),
      true,
      JSON.stringify(unquotedRejected.diagnostics)
    );
  });

  it("proof-binds submit guards and WBS row-state scripts", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const actions = dslDraft.scripts.actions;
    const attachment = actions.find((action) =>
      action.functionMappings?.some((mapping) =>
        mapping.basis === "deterministic-procurement-payment-attachment-submit"
      )
    );
    const department = actions.find((action) =>
      action.functionMappings?.some((mapping) =>
        mapping.basis === "deterministic-procurement-payment-department-consistency"
      )
    );
    const wbsActions = actions.filter((action) =>
      action.functionMappings?.some((mapping) =>
        mapping.basis === "deterministic-procurement-payment-wbs-visibility"
      )
    );

    assert.equal(attachment.translationStatus, "mapped");
    assert.equal(
      attachment.deterministicBranchProof.basis,
      "deterministic-procurement-payment-attachment-submit"
    );
    assert.match(attachment.function, /MKXFORM\.getValue\("fd_attachment"\)/u);
    assert.equal(department.translationStatus, "mapped");
    assert.equal(
      department.deterministicBranchProof.basis,
      "deterministic-procurement-payment-department-consistency"
    );
    assert.match(department.function, /MKXFORM\.getValue\("\$\{table:fd_pur_pay_req\}"\)/u);

    assert.equal(wbsActions.length, 3);
    for (const action of wbsActions) {
      assert.equal(action.translationStatus, "mapped");
      assert.match(action.function, /MKXFORM\.setFieldAttr\("fd_htz_row"/u);
      assert.equal(
        action.deterministicBranchProof.basis,
        "deterministic-procurement-payment-wbs-visibility"
      );
    }
    const wbsChange = wbsActions.find((action) => action.event === "onChange");
    const wbsRule = dslDraft.formRules.linkage.find((rule) =>
      rule.id === "linkage.fd_haswbs.contains.YES"
    );
    assert.equal(wbsChange.sourceActionKey, wbsRule.meta.sourceActionKey);

    assert.equal(
      checkDraft(dslDraft).diagnostics.some((diagnostic) => diagnostic.level === "error"),
      false
    );
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-07-28T00:00:00.000Z"
    });
    assert.equal(
      checkTrust(sourceDraft, trusted).diagnostics.some((diagnostic) => diagnostic.level === "error"),
      false
    );

    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);
    const routeReadbackErrors = readback.diagnostics
      .filter((diagnostic) => (
        diagnostic.code === "readback.form.prop_defaultValue_mismatch" &&
        diagnostic.details?.fieldId === "fd_apply_post"
      ) || (
        diagnostic.code === "readback.workflow.edge_condition_native_semantic_mismatch" &&
        ["L39", "L49", "L76"].some((edgeId) =>
          diagnostic.path === `/readback/workflow/edges/${edgeId}/condition`
        )
      ))
      .map((diagnostic) => ({
        code: diagnostic.code,
        path: diagnostic.path
      }));
    assert.deepEqual(routeReadbackErrors, []);
  });
});
