import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/semantic-props";
const help = "起草人节点请选择：区域经理管理处、策略采购主管、分管副总/分管领导（如有）的节点处理人，否则流程将报错。";

describe("semantic source props Route case", { concurrency: false }, () => {
  it("merges designer-only detail columns by natural id without changing designer order", () => {
    const { source, dsl } = stages();
    const sourceColumns = source.form.detailTables.find((field) => field.id === "fd_detail").columns;
    const dslColumns = dsl.form.fields.find((field) => field.id === "fd_detail").columns;

    assert.deepEqual(sourceColumns.map((field) => field.id), ["fd_wbs", "fd_ebeln", "fd_site", "fd_detail_amount"]);
    assert.deepEqual(dslColumns.map((field) => field.id), ["fd_wbs", "fd_ebeln", "fd_site", "fd_detail_amount"]);
    assert.equal(dslColumns.filter((field) => field.id === "fd_wbs").length, 1);
    assert.equal(dslColumns.find((field) => field.id === "fd_wbs").title, "WBS/成本中心");
  });

  it("owns a direct-break styled detail-header hint as the matching column placeholder", () => {
    const { source, dsl } = stages();
    const sourceColumn = source.form.detailTables[0].columns.find((field) => field.id === "fd_ebeln");
    const dslColumn = dsl.form.fields.find((field) => field.id === "fd_detail")
      .columns.find((field) => field.id === "fd_ebeln");

    assert.equal(sourceColumn.sourceProps.inlineHint.content, "*不超过10个字符");
    assert.equal(dslColumn.props.placeholder, "*不超过10个字符");
  });

  it("prefers explicit bound and detail-header captions over internal numbered labels", () => {
    const { source, dsl } = stages();
    const sourceMain = source.form.controls.find((field) => field.id === "fd_requirement");
    const dslMain = dsl.form.fields.find((field) => field.id === "fd_requirement");
    const dslSite = dsl.form.fields.find((field) => field.id === "fd_detail")
      .columns.find((field) => field.id === "fd_site");

    assert.equal(sourceMain.title, "采购需求说明");
    assert.equal(dslMain.title, "采购需求说明");
    assert.equal(dslSite.title, "风场名称");
  });

  it("folds an adjacent number unit and verifies it through native readback", async () => {
    const { source, dsl } = stages();
    const sourceAmount = source.form.controls.find((field) => field.id === "fd_estimate");
    const dslAmount = dsl.form.fields.find((field) => field.id === "fd_estimate");
    const result = await runRouteCase("semantic-props-success");
    const readbackAmount = result.execution.readback.form.fields.find((field) => field.id === "fd_estimate");

    assert.equal(sourceAmount.sourceProps.inlineUnit.content, "元");
    assert.equal(source.form.controls.some((field) => field.id === "estimate_unit"), false);
    assert.equal(dslAmount.props.unit, "元");
    assert.equal(readbackAmount.unit, "元");
  });

  it("does not fold a unit across an intervening designer element", () => {
    const { source, dsl } = stages();
    const sourceAmount = source.form.controls.find((field) => field.id === "fd_guarded_estimate");
    const dslAmount = dsl.form.fields.find((field) => field.id === "fd_guarded_estimate");

    assert.equal(sourceAmount.sourceProps.inlineUnit, undefined);
    assert.equal(dslAmount.props.unit, undefined);
    assert.equal(source.form.controls.some((field) => field.id === "guarded_estimate_unit"), true);
  });

  it("preserves an explicit literal initial value in the DSL", () => {
    const { source, dsl } = stages();
    const sourceCurrency = source.form.controls.find((field) => field.id === "fd_currency");
    const dslCurrency = dsl.form.fields.find((field) => field.id === "fd_currency");

    assert.equal(sourceCurrency.sourceProps.designerValues.defaultValue, "CNY");
    assert.equal(sourceCurrency.sourceProps.metadataAttributes.defaultValue, "CNY");
    assert.deepEqual(dslCurrency.props.defaultValue, { kind: "literal", value: "CNY" });
  });

  it("projects literal initial values through Native fixed/formula defaults and readback", async () => {
    const result = await runRouteCase("semantic-props-success");
    const currency = result.execution.readback.form.fields.find((field) => field.id === "fd_currency");
    const detailAmount = result.execution.readback.form.fields.find((field) => field.id === "fd_detail")
      .columns.find((field) => field.id === "fd_detail_amount");

    assert.deepEqual(currency.defaultValue, { kind: "literal", value: "CNY" });
    assert.deepEqual(detailAmount.defaultValue, { kind: "literal", value: 0 });
  });

  it("projects main arithmetic and detail SUM as Native calculation rules and readback", async () => {
    const { dsl } = stages();
    const formula = dsl.form.fields.find((field) => field.id === "fd_formula_total");
    const aggregate = dsl.form.fields.find((field) => field.id === "fd_detail_total");
    const result = await runRouteCase("semantic-props-success");
    const readbackFormula = result.execution.readback.form.fields.find((field) => field.id === formula.id);
    const readbackAggregate = result.execution.readback.form.fields.find((field) => field.id === aggregate.id);

    assert.equal(formula.componentId, "xform-calculate");
    assert.deepEqual(formula.props.calculation, {
      kind: "formula",
      expression: "$fd_estimate$ + $fd_guarded_estimate$",
      displayExpression: "$采购估价$ + $有介入控件的估价$",
      fieldIds: ["fd_estimate", "fd_guarded_estimate"]
    });
    assert.deepEqual(aggregate.props.calculation, {
      kind: "aggregate",
      operation: "sum",
      tableId: "fd_detail",
      fieldId: "fd_detail_amount"
    });
    assert.deepEqual(readbackFormula.calculation, formula.props.calculation);
    assert.deepEqual(readbackAggregate.calculation, aggregate.props.calculation);
    assert.deepEqual(
      result.execution.readback.form.fields.find((field) => field.id === "fd_detail").columns.map((column) => column.id),
      ["fd_wbs", "fd_ebeln", "fd_site", "fd_detail_amount"]
    );
  });

  it("normalizes source node help and verifies its localized Native readback", async () => {
    const { source, dsl } = stages();
    const result = await runRouteCase("semantic-props-success");

    assert.equal(source.workflow.nodes.find((node) => node.id === "N2").help, help);
    assert.equal(dsl.workflow.nodes.find((node) => node.id === "N2").help, help);
    assert.equal(result.execution.readback.workflow.nodes.find((node) => node.id === "N2").help, help);
  });
});

function stages() {
  const source = cleanSourceFile(fixture);
  return { source, dsl: draftSourceDraft(source) };
}
