import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectTemplate } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

describe("conditional formula Route case", { concurrency: false }, () => {
  it("preserves source formulas and reads every automatic branch as a native formula", async () => {
    const result = await runRouteCase("conditional-detail-success");
    const dslEdges = new Map(result.dsl.workflow.edges.map((edge) => [edge.id, edge]));

    assert.deepEqual(dslEdges.get("L7")?.condition, {
      sourceText: "$fd_condition_org$.fdNo.equals(\"ROUTE_ORG_001\")",
      displayText: "$申请单位$.fdNo.equals(\"ROUTE_ORG_001\")",
      targetText: "$fd_condition_org$.fdNo.equals(\"ROUTE_ORG_001\")",
      translationStatus: "display_only"
    });
    assert.deepEqual(dslEdges.get("L8")?.condition, {
      sourceText: "null!=$fd_route_type$",
      displayText: "null!=$类型$",
      targetText: "null!=$fd_route_type$",
      translationStatus: "display_only"
    });
    assert.deepEqual(dslEdges.get("L9")?.condition, {
      sourceText: "($fd_formula_amount_a$+$fd_formula_amount_b$) < 300000",
      displayText: "($条件分支$+$累计金额$) < 300000",
      targetText: "($fd_formula_amount_a$+$fd_formula_amount_b$) < 300000",
      translationStatus: "display_only"
    });
    assert.deepEqual(dslEdges.get("L10")?.condition, {
      sourceText: "1==2",
      displayText: "1==2",
      targetText: "1==2",
      translationStatus: "display_only"
    });

    const branch = result.dsl.workflow.nodes.find((node) => node.id === "N3");
    const branchField = result.dsl.form.fields.find((field) => field.title === branch.name);
    assert.equal(branchField.id, "fd_formula_amount_a");
    assert.equal(branchField.type, "number");
    assert.equal(
      result.dsl.form.fields.find((field) => field.id === "fd_formula_amount_b")?.type,
      "number"
    );
    assert.deepEqual(
      ["N5", "N6"].map((nodeId) => {
        const participants = result.dsl.workflow.nodes.find((node) => node.id === nodeId)?.participants;
        return {
          mode: participants?.mode,
          recipe: participants?.recipe,
          detailTableId: participants?.detailTableId,
          fieldId: participants?.fieldId
        };
      }),
      [
        { mode: "script_formula", recipe: "detail_login_names_to_persons", detailTableId: "fd_route_detail", fieldId: "fd_detail_name" },
        { mode: "script_formula", recipe: "first_detail_department_code_to_head", detailTableId: "fd_route_detail", fieldId: "fd_detail_name" }
      ]
    );

    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.readback.partitions.workflow, "verified");
    const readbackEdges = new Map(
      result.execution.readback.workflow.edges.map((edge) => [edge.id, edge])
    );
    assert.deepEqual(readbackEdges.get("L7")?.condition, {
      nativeKind: "batch_formula",
      nativeStatus: "ok",
      functionIds: ["sysorg.isOrganizationBelongOrIncludeAnother"],
      orgIds: ["route-org-001"]
    });
    assert.deepEqual(readbackEdges.get("L8")?.condition, {
      nativeKind: "batch_formula",
      nativeStatus: "ok",
      functionIds: ["global.isEmpty"],
      orgIds: []
    });
    // Field-sum comparisons persist as formula-designer Eval scripts.
    assert.deepEqual(readbackEdges.get("L9")?.condition, {
      nativeKind: "eval_formula",
      nativeStatus: "ok",
      functionIds: [],
      orgIds: []
    });
    assert.deepEqual(readbackEdges.get("L10")?.condition, {
      nativeKind: "batch_formula",
      nativeStatus: "ok",
      functionIds: [],
      orgIds: []
    });
    assert.equal(readbackEdges.get("L10")?.isDefault, false);

    const template = projectTemplate(result.dsl);
    const workflow = JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent);
    const persistedBranch = workflow.elements.find((element) => element.id === "N3");
    const persistedDefaultEdge = workflow.elements.find((element) => element.id === "L4");
    const defaultFormula = JSON.parse(persistedDefaultEdge.formula);
    const branchConditionValue = JSON.parse(persistedBranch.conditionValue);
    const branchRoutes = branchConditionValue.formulas || branchConditionValue.rules;

    assert.deepEqual(defaultFormula, {
      type: "Eval",
      script: "1==1",
      vo: {
        mode: "formula",
        content: "1==1"
      }
    });
    assert.equal(persistedDefaultEdge.formulaName, "1==1");
    assert.equal(persistedDefaultEdge.formulaType, "formula");
    assert.equal(persistedDefaultEdge.defaultTrend, true);
    assert.equal(persistedBranch.default, "L4");
    assert.equal(persistedBranch.conditionId, "L4");
    assert.deepEqual(
      JSON.parse(persistedBranch.resultSetMapping).find((entry) => entry.id === "L4"),
      { id: "L4", resultCode: "1==1" }
    );
    assert.deepEqual(
      branchRoutes.find((entry) => entry.lineId === "L4"),
      {
        lineId: "L4",
        lineName: "默认业务路径",
        priority: 3,
        formula: defaultFormula,
        formulaName: "1==1",
        formulaType: "formula",
        mode: "formula",
        defaultTrend: true,
        type: "formulas",
        formulaConfig: defaultFormula
      }
    );
    assert.deepEqual(readbackEdges.get("L4")?.condition, {
      nativeKind: "eval_formula",
      nativeStatus: "ok",
      functionIds: [],
      orgIds: []
    });
    assert.equal(readbackEdges.get("L4")?.isDefault, true);
  });
});
