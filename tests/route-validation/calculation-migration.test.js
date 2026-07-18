import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/calculation-migration/route-calculation-migration_SysFormTemplate.xml";

describe("calculation migration Route case", () => {
  it("does not let one native inference suppress unrelated calculation behavior in the same source", () => {
    const { dsl } = stages();
    const manual = dsl.scripts.calculationDecisions.find(decision =>
      decision.classification === "manual" &&
      decision.sourceRefs.includes("source.form.jsp.jsp_clamped_sum.script.1") &&
      decision.targetRefs.includes("fd_recompute_output")
    );

    assert.ok(manual);
    assert.equal(manual.targetRefs.includes("fd_recompute_output"), true);
  });

  it("maps an explicit main-table arithmetic formula", () => {
    const { dsl } = stages();

    assert.equal(field(dsl, "fd_main_total").type, "number");
    assert.equal(field(dsl, "fd_main_total").componentId, "xform-calculate");
    assert.deepEqual(field(dsl, "fd_main_total").props.calculation, {
      kind: "formula",
      expression: "$fd_main_left$ + $fd_main_right$",
      displayExpression: "$主表左值$ + $主表右值$",
      fieldIds: ["fd_main_left", "fd_main_right"]
    });
  });

  it("maps an explicit detail-row arithmetic formula with row-local dependencies", () => {
    const { dsl } = stages();
    const lineTotal = detailColumn(dsl, "fd_lines", "fd_line_total");

    assert.equal(lineTotal.type, "number");
    assert.equal(lineTotal.componentId, "xform-calculate");
    assert.deepEqual(lineTotal.props.calculation, {
      kind: "formula",
      expression: "$fd_quantity$ * $fd_unit_price$",
      displayExpression: "$数量$ * $单价$",
      fieldIds: ["fd_quantity", "fd_unit_price"]
    });
  });

  it("maps a main-table SUM over a calculated detail column", () => {
    const { dsl } = stages();

    assert.deepEqual(field(dsl, "fd_detail_sum").props.calculation, {
      kind: "aggregate",
      operation: "sum",
      tableId: "fd_lines",
      fieldId: "fd_line_total"
    });
  });

  it("composes a nonnegative aggregate through a generated data-only SUM field", () => {
    const { dsl } = stages();
    const target = field(dsl, "fd_clamped_sum");
    const helper = dsl.form.fields.find((candidate) =>
      candidate.dataOnly === true &&
      candidate.sourceProps?.generatedCalculation?.targetFieldId === "fd_clamped_sum"
    );

    assert.ok(helper);
    assert.equal(helper.generated, true);
    assert.deepEqual(helper.props.calculation, {
      kind: "aggregate",
      operation: "sum",
      tableId: "fd_lines",
      fieldId: "fd_line_total"
    });
    assert.deepEqual(target.props.calculation, {
      kind: "formula",
      expression: `Math.max($${helper.id}$, 0)`,
      displayExpression: `MAX($${helper.title}$, 0)`,
      fieldIds: [helper.id]
    });
    assert.equal(
      dsl.scripts.calculationDecisions.some((decision) =>
        decision.code === "calculation.aggregate_nonnegative_clamp" &&
        decision.classification === "manual"
      ),
      false
    );
  });

  it("maps a safe synchronous onChange recalculation without legacy DOM code", () => {
    const { dsl } = stages();
    const action = dsl.scripts.actions.find((candidate) =>
      candidate.event === "onChange" && candidate.controlId === "fd_recompute_input"
    );

    assert.equal(action?.translationStatus, "mapped");
    assert.deepEqual(action?.runWhen, { viewStatusIn: ["add", "edit"] });
    assert.match(action?.function || "", /MKXFORM\.setValue\(['"]fd_recompute_output['"], Number\(value \|\| 0\) \* 2\)/);
    assert.doesNotMatch(action?.function || "", /SetXFormFieldValueById|jQuery|\$\(/);
    assert.equal(dsl.scripts.warnings.length, 0);
  });

  it("scopes runtime-difference locals to one caller and rejects reordered reads", () => {
    const { dsl } = stages();

    assert.deepEqual(field(dsl, "fd_recompute_output").props.calculation, {
      kind: "formula",
      expression: "$fd_detail_sum$ - $fd_recompute_input$",
      displayExpression: "$fd_detail_sum$ - $fd_recompute_input$",
      fieldIds: ["fd_detail_sum", "fd_recompute_input"]
    });
    assert.match(field(dsl, "fd_clamped_sum").props.calculation.expression, /^Math\.max/);
    assert.ok(dsl.scripts.calculationDecisions.some(decision =>
      decision.classification === "manual" &&
      decision.sourceRefs.includes("source.form.jsp.jsp_clamped_sum.script.1") &&
      decision.targetRefs.includes("fd_clamped_sum")
    ));
  });

  it("fails closed for unsafe selectors, intervening mutations, and duplicate helper definitions", () => {
    const { dsl } = stages();
    const rejectedTargets = [
      "fd_unsafe_selector_sum",
      "fd_unsafe_mutated_sum",
      "fd_unsafe_diff",
      "fd_unsafe_duplicate_sum"
    ];

    for (const targetId of rejectedTargets) {
      assert.equal(field(dsl, targetId).props.calculation, undefined, targetId);
      assert.ok(dsl.scripts.calculationDecisions.some(decision =>
        decision.classification === "manual" && decision.targetRefs.includes(targetId)
      ), `${targetId} must remain explicit manual evidence`);
    }
  });

  it("fails closed for conflicting targets and calculations enclosed by source control flow", () => {
    const { dsl } = stages();
    for (const targetId of [
      "fd_inference_conflict",
      "fd_unsafe_conditional_sum",
      "fd_unsafe_cond_diff",
      "fd_unsafe_comment_sum"
    ]) {
      assert.equal(field(dsl, targetId).props.calculation, undefined, targetId);
      assert.ok(dsl.scripts.calculationDecisions.some(decision =>
        decision.classification === "manual" && decision.targetRefs.includes(targetId)
      ), `${targetId} must retain conflicting or conditional source evidence`);
    }
  });

  it("maps a detail-row threshold calculation without preserving legacy DOM access", () => {
    const { dsl } = stages();
    const actions = dsl.scripts.actions.filter((candidate) =>
      candidate.tableId === "fd_lines" &&
      ["fd_threshold_kind", "fd_threshold_input"].includes(candidate.controlId)
    );

    assert.equal(actions.length, 2);
    for (const action of actions) {
      assert.equal(action.translationStatus, "mapped");
      assert.deepEqual(action.runWhen, { viewStatusIn: ["add", "edit"] });
      assert.match(action.function, /MKXFORM\.getValue\("\$\{table:fd_lines\}\.fd_threshold_input"/);
      assert.match(action.function, /MKXFORM\.updateControl\("\$\{table:fd_lines\}\.fd_threshold_result", rowNum, operand > 0 \? 100 : 0\)/);
      assert.doesNotMatch(action.function, /GetXFormSameRowFieldById|jQuery|\$\(/);
    }
  });

  it("projects calculations and the onChange binding through Native readback", async () => {
    const result = await runRouteCase("calculation-migration-success");
    const main = field(result.execution.readback.form, "fd_main_total");
    const line = detailColumn(result.execution.readback.form, "fd_lines", "fd_line_total");
    const sum = field(result.execution.readback.form, "fd_detail_sum");
    const clamped = field(result.execution.readback.form, "fd_clamped_sum");
    const clampHelper = result.dsl.form.fields.find((candidate) =>
      candidate.dataOnly === true &&
      candidate.sourceProps?.generatedCalculation?.targetFieldId === "fd_clamped_sum"
    );
    const readbackHelper = field(result.execution.readback.form, clampHelper.id);
    const action = result.execution.readback.form.scripts.actions.find((candidate) =>
      candidate.event === "onChange" && candidate.controlKey?.endsWith(".fd_recompute_input")
    );

    assert.deepEqual(main.calculation, field(result.dsl, "fd_main_total").props.calculation);
    assert.deepEqual(line.calculation, detailColumn(result.dsl, "fd_lines", "fd_line_total").props.calculation);
    assert.deepEqual(sum.calculation, field(result.dsl, "fd_detail_sum").props.calculation);
    assert.deepEqual(readbackHelper.calculation, clampHelper.props.calculation);
    assert.deepEqual(clamped.calculation, field(result.dsl, "fd_clamped_sum").props.calculation);
    assert.deepEqual(result.execution.readback.form.calculationOrder, [
      "fd_main_total",
      "fd_lines.fd_line_total",
      "fd_detail_sum",
      "fd_recompute_output",
      clampHelper.id,
      "fd_clamped_sum"
    ]);
    assert.equal(action.event, "onChange");
    assert.match(action.controlKey, /\.fd_recompute_input$/);
    assert.deepEqual(action.runWhen, { viewStatusIn: ["add", "edit"] });
    assert.equal(action.hasCanonicalGuard, true);
    for (const controlId of ["fd_threshold_kind", "fd_threshold_input"]) {
      const detailAction = result.execution.readback.form.scripts.actions.find((candidate) =>
        candidate.event === "onChange" && candidate.controlKey?.endsWith(`.${controlId}`)
      );
      assert.equal(detailAction?.hasCanonicalGuard, true);
    }
  });
});

function stages() {
  const source = cleanSourceFile(fixture);
  return { source, dsl: draftSourceDraft(source) };
}

function field(dsl, id) {
  const fields = dsl.form?.fields || dsl.fields || [];
  return fields.find((candidate) => candidate.id === id);
}

function detailColumn(dsl, tableId, columnId) {
  return field(dsl, tableId).columns.find((candidate) => candidate.id === columnId);
}
