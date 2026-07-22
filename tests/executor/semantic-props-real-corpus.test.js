import assert from "node:assert/strict";
import { describe } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { localCorpusIt } from "../helpers/local-corpus.js";
import { persistAndVerify, xformConfig } from "../helpers/persistence.js";

const sourcePath = "tests/fixtures/source/1670297c984b45009eb5b1e444d9957d";
const detailId = "fd_3e501d840bbb6e";
const help = "起草人节点请选择：区域经理管理处、策略采购主管、分管副总/分管领导（如有）的节点处理人，否则流程将报错。";

describe("real source 167 semantic props regression", () => {
  localCorpusIt("preserves all five reported semantics through native projection and readback", () => {
    const source = cleanSourceFile(sourcePath);
    const draft = draftSourceDraft(source);
    const sourceDetail = source.form.detailTables.find((field) => field.id === detailId);
    const dslDetail = draft.form.fields.find((field) => field.id === detailId);
    const amount = draft.form.fields.find((field) => field.id === "fd_38e47229dbeb7c");
    const sourceAmount = source.form.controls.find((field) => field.id === amount.id);
    const dsl = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "semantic-props-regression",
      checkedAt: "2026-07-17T00:00:00.000Z"
    });
    const { template, readback } = persistAndVerify(dsl);
    const readbackDetail = readback.form.fields.find((field) => field.id === detailId);
    const sourceWbsIndex = sourceDetail.columns.findIndex((column) => column.id === "fd_wbs");
    const dslWbsIndex = dslDetail.columns.findIndex((column) => column.id === "fd_wbs");

    assert.equal(sourceDetail.columns.filter((column) => column.id === "fd_wbs").length, 1);
    assert.equal(dslDetail.columns.filter((column) => column.id === "fd_wbs").length, 1);
    assert.equal(dslDetail.columns.find((column) => column.id === "fd_wbs").title, "WBS/成本中心");
    assert.equal(dslWbsIndex, sourceWbsIndex);
    assert.equal(nativeControlProps(template, "fd_wbs").title, "WBS/成本中心");
    assert.equal(readbackDetail.columns[dslWbsIndex].id, "fd_wbs");
    assert.equal(readbackDetail.columns[dslWbsIndex].title, "WBS/成本中心");

    const purchaseOrder = dslDetail.columns.find((column) => column.id === "fd_ebeln");
    assert.equal(purchaseOrder.props.placeholder, "*不超过10个字符");
    assert.equal(nativeControlProps(template, "fd_ebeln").placeholder, "*不超过10个字符");
    assert.equal(
      readback.form.fields.find((field) => field.id === detailId)
        .columns.find((column) => column.id === "fd_ebeln").placeholder,
      "*不超过10个字符"
    );

    assert.equal(draft.form.fields.find((field) => field.id === "fd_38e46fdbbf48de").title, "采购需求说明");
    assert.equal(nativeControlProps(template, "fd_38e46fdbbf48de").title, "采购需求说明");
    assert.equal(readback.form.fields.find((field) => field.id === "fd_38e46fdbbf48de").title, "采购需求说明");
    assert.equal(draft.form.fields.find((field) => field.id === "fd_3e501d85c8795a")
      .columns.find((column) => column.id === "fd_workprodescription").title, "风场名称");
    assert.equal(nativeControlProps(template, "fd_workprodescription").title, "风场名称");
    assert.equal(readback.form.fields.find((field) => field.id === "fd_3e501d85c8795a")
      .columns.find((column) => column.id === "fd_workprodescription").title, "风场名称");
    assert.equal(draft.form.fields.find((field) => field.id === "fd_3e501d87ae5c80")
      .columns.find((column) => column.id === "fd_otherprodescription").title, "风场名称");
    assert.equal(nativeControlProps(template, "fd_otherprodescription").title, "风场名称");
    assert.equal(readback.form.fields.find((field) => field.id === "fd_3e501d87ae5c80")
      .columns.find((column) => column.id === "fd_otherprodescription").title, "风场名称");

    assert.deepEqual(sourceAmount.sourceProps.inlineUnit, {
      id: "fd_38e4722c9c90ba",
      content: "元",
      relation: "immediately-adjacent-plain-text-in-same-cell"
    });
    assert.equal(source.form.controls.some((field) => field.id === "fd_38e4722c9c90ba"), false);
    assert.equal(draft.form.fields.some((field) => field.id === "fd_38e4722c9c90ba"), false);
    assert.equal(layoutReferenceIds(draft).includes("fd_38e4722c9c90ba"), false);
    assert.equal(nativeFieldIds(template).includes("fd_38e4722c9c90ba"), false);
    assert.equal(readback.form.fields.some((field) =>
      field.id === "fd_38e4722c9c90ba" ||
      field.columns?.some((column) => column.id === "fd_38e4722c9c90ba")
    ), false);
    assert.equal(amount.props.unit, "元");
    assertNativeNumberUnit(template, amount.id, "元", amount.props.precision);
    assert.equal(readback.form.fields.find((field) => field.id === amount.id).unit, "元");

    assert.equal(source.workflow.nodes.find((node) => node.id === "N2").help, help);
    assert.equal(draft.workflow.nodes.find((node) => node.id === "N2").help, help);
    const nativeN2 = nativeWorkflowNode(template, "N2");
    assert.equal(nativeN2.description, help);
    assert.equal(nativeN2.language.descriptionCn, help);
    assert.equal(readback.workflow.nodes.find((node) => node.id === "N2").help, help);
    assert.equal(readback.diagnostics.some((item) =>
      item.code === "readback.form.prop_unit_mismatch" ||
      (item.code === "readback.workflow.node_help_mismatch" && item.details?.nodeId === "N2")
    ), false);
  });
});

function nativeControlProps(template, fieldId) {
  const { field } = nativeField(template, fieldId);
  return JSON.parse(field.fdAttribute).config.controlProps;
}

function assertNativeNumberUnit(template, fieldId, unit, precision) {
  const { config, field } = nativeField(template, fieldId);
  const controlProps = JSON.parse(field.fdAttribute).config.controlProps;
  const fontExtendData = JSON.parse(field.fdFontExtendData);
  const lang = JSON.parse(config.lang || "{}");
  const unitToken = controlProps.numberFormat.unit;

  assert.equal(controlProps.unit, undefined);
  assert.match(unitToken, /^!\{[^}]+\}$/u);
  const expectedFormat = Number.isInteger(precision) ? "decimal" : "base";
  assert.equal(controlProps.numberFormat.formatType, expectedFormat);
  assert.equal(fontExtendData.unit, unitToken);
  assert.equal(fontExtendData.formatType, expectedFormat);
  if (Number.isInteger(precision)) {
    assert.equal(controlProps.valueType.precision, precision);
    assert.equal(controlProps.numberFormat.precision, String(precision));
    assert.equal(fontExtendData.precision, String(precision));
  }
  assert.deepEqual(lang[unitToken], {
    prop: "numberFormat",
    name: fieldId,
    type: "input",
    content: { Cn: unit, default: unit }
  });
}

function nativeField(template, fieldId) {
  const config = xformConfig(template);
  const field = config.dataModel.flatMap((model) => model.fdFields || [])
    .find((candidate) => candidate.fdName === fieldId);
  return { config, field };
}

function nativeFieldIds(template) {
  return xformConfig(template).dataModel
    .flatMap((model) => (model.fdFields || []).map((field) => field.fdName));
}

function layoutReferenceIds(dsl) {
  return (dsl.form.layout?.sourceGrid?.rows || []).flatMap((row) =>
    (row.cells || []).flatMap((cell) =>
      (cell.references || []).map((reference) => reference.referenceId)
    )
  );
}

function nativeWorkflowNode(template, nodeId) {
  const content = JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent);
  return content.elements.find((element) => element.id === nodeId);
}
