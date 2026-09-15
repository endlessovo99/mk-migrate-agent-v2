import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftSourceDraft } from "../../src/translator/dsl-draft.js";
import { cleanSourceFile } from "../../src/translator/source-draft.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { selectContentFlow } from "../../src/dsl/content-flow.js";

function sourceForm() {
  const controls = [
    { id: "fd_prompt", title: "数量", sourceType: "description", sourceProps: { designerType: "textLabel", designerValues: { content: "数量" } } },
    { id: "fd_quantity", title: "数量", sourceType: "number", sourceProps: { designerType: "inputText", layoutCell: { hiddenLabel: true }, inlineUnit: { id: "fd_unit", content: "件" } } },
    { id: "fd_unit", title: "件", sourceType: "description", sourceProps: { designerType: "textLabel", designerValues: { content: "件" } } },
    { id: "fd_calculation", title: "合计", sourceType: "number", sourceProps: { designerType: "calculation", layoutCell: { hiddenLabel: true }, designerValues: { expression_id: "$fd_quantity$ * 2", expression_name: "$数量$ * 2", decimal: "0" }, inlineUnit: { id: "fd_result_unit", content: "份" } } },
    { id: "fd_result_unit", title: "份", sourceType: "description", sourceProps: { designerType: "textLabel", designerValues: { content: "份" } } }
  ].map((control) => ({ ...control, sourceRef: `source.form.control.${control.id}` }));
  return {
    version: "2.0-source-draft", artifact: "source-draft",
    source: { sourceId: "flow-fixture" }, template: { name: "混合内容" }, issues: [],
    form: { controls, dataFields: [], detailTables: [], layout: { source: "fdDesignerHtml", rows: [{
      id: "row-0", sourceRef: "source.form.layout.row.row-0", columns: 1,
      preserveSourceGeometry: true, cells: [{
        id: "cell-0", sourceRef: "source.form.layout.cell.cell-0", column: 0, colspan: 1,
        references: controls.map((control) => ({ referenceType: "control", referenceId: control.id, sourceRef: control.sourceRef })),
        contentFlow: {
          lines: [["fd_prompt", "fd_quantity", "fd_unit"], [], ["fd_calculation", "fd_result_unit"]],
          items: controls.map((control) => ({ referenceId: control.id, ...(["fd_quantity", "fd_calculation"].includes(control.id) ? { width: { value: 120, unit: "px" } } : {}) }))
        }
      }]
    }] } }
  };
}

describe("source content flow and presentation fidelity", () => {
  it("preserves mixed lines, empty breaks and widths while consuming only native-supported units", () => {
    const draft = draftSourceDraft(sourceForm());
    const fields = new Map(draft.form.fields.map((field) => [field.id, field]));
    assert.equal(fields.get("fd_quantity").props.unit, "件");
    assert.equal(fields.has("fd_unit"), false);
    assert.equal(fields.get("fd_calculation").props.unit, undefined);
    assert.equal(fields.get("fd_result_unit").props.content, "份");
    assert.equal(fields.get("fd_quantity").props.hiddenLabel, true);
    assert.equal(fields.get("fd_calculation").props.hiddenLabel, true);
    const cell = draft.form.layout.mkTree[0].children[0];
    assert.deepEqual(cell.contentFlow.lines, [["fd_prompt", "fd_quantity"], [], ["fd_calculation", "fd_result_unit"]]);
    assert.deepEqual(cell.contentFlow.items.find((item) => item.referenceId === "fd_calculation").width, { value: 120, unit: "px" });
    assert.equal(checkDraft(draft).ok, true);
  });

  it("remaps long field ids in every flow reference", () => {
    const source = sourceForm();
    const longId = "fd_calculation_with_a_long_source_identifier";
    const rewritten = JSON.parse(JSON.stringify(source).replaceAll("fd_calculation", longId));
    const draft = draftSourceDraft(rewritten);
    const target = draft.form.fields.find((field) => field.sourceProps?.originalId === longId);
    assert.ok(target);
    const cell = draft.form.layout.mkTree[0].children[0];
    assert.ok(cell.contentFlow.lines.flat().includes(target.id));
    assert.ok(cell.contentFlow.items.some((item) => item.referenceId === target.id));
    assert.equal(checkDraft(draft).ok, true);
  });

  for (const mutation of ["missing-flow", "lost-break", "lost-width", "hidden-label", "native-unit", "text-unit"]) {
    it(`rejects source presentation loss: ${mutation}`, () => {
      const source = sourceForm();
      const trusted = createTrustedMigrationDsl(source, draftSourceDraft(source), { externalAgentReviewed: true });
      assert.equal(checkTrust(source, trusted).ok, true);
      const cell = trusted.form.layout.mkTree[0].children[0];
      if (mutation === "missing-flow") delete cell.contentFlow;
      if (mutation === "lost-break") cell.contentFlow.lines = [cell.contentFlow.lines.flat()];
      if (mutation === "lost-width") delete cell.contentFlow.items.find((item) => item.width).width;
      if (mutation === "hidden-label") delete trusted.form.fields.find((field) => field.id === "fd_calculation").props.hiddenLabel;
      if (mutation === "native-unit") delete trusted.form.fields.find((field) => field.id === "fd_quantity").props.unit;
      if (mutation === "text-unit") trusted.form.fields.find((field) => field.id === "fd_result_unit").props.content = "错误单位";
      const result = checkTrust(source, trusted);
      assert.equal(result.ok, false, mutation);
      assert.ok(result.diagnostics.some((item) => item.code.startsWith("trust.form.presentation_")), JSON.stringify(result.diagnostics));
    });
  }

  for (const mutation of ["data-only", "hidden-control"]) {
    it(`rejects removing visible source contents through a target ${mutation} annotation`, () => {
      const source = sourceForm();
      const trusted = createTrustedMigrationDsl(source, draftSourceDraft(source), { externalAgentReviewed: true });
      const field = trusted.form.fields.find((candidate) => candidate.id === "fd_calculation");
      if (mutation === "data-only") field.dataOnly = true;
      else Object.assign(field, { type: "text", componentId: "xform-hidden", props: {} });
      delete field.props.hiddenLabel;
      const cell = trusted.form.layout.mkTree[0].children[0];
      cell.refIds = cell.refIds.filter((id) => id !== field.id);
      cell.contentFlow = selectContentFlow(cell.contentFlow, cell.refIds);

      const result = checkTrust(source, trusted);
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some((item) => item.code === "trust.form.presentation_visibility_mismatch"));
    });
  }

  it("allows non-rendered data fields established by the source", () => {
    const source = sourceForm();
    source.form.dataFields.push({
      id: "fd_internal", title: "内部字段", sourceType: "text", dataOnly: true,
      sourceRef: "source.form.control.fd_internal", sourceProps: { layoutCell: { hiddenLabel: true } }
    });
    const trusted = createTrustedMigrationDsl(source, draftSourceDraft(source), { externalAgentReviewed: true });
    assert.equal(trusted.form.fields.find((field) => field.id === "fd_internal").dataOnly, true);
    const result = checkTrust(source, trusted);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  });

  it("allows a source-rebuilt address display companion while retaining its visible width", () => {
    const source = cleanSourceFile("tests/fixtures/route-validation/compact-procurement-layout/route-compact-procurement-layout_SysFormTemplate.xml");
    const trusted = createTrustedMigrationDsl(source, draftSourceDraft(source), { externalAgentReviewed: true });
    assert.equal(trusted.form.fields.find((field) => field.id === "fd_department.name").dataOnly, true);
    const cell = trusted.form.layout.mkTree.flatMap((node) => node.children)
      .find((candidate) => candidate.contentFlow?.items.some((item) => item.referenceId === "fd_department"));
    const addressItem = cell.contentFlow.items.find((item) => item.referenceId === "fd_department");
    assert.deepEqual(addressItem.width, { value: 300, unit: "px" });
    assert.equal(checkTrust(source, trusted).ok, true, JSON.stringify(checkTrust(source, trusted).diagnostics));
    addressItem.width.value = 0;
    assert.ok(checkTrust(source, trusted).diagnostics.some((item) => item.code === "trust.form.presentation_content_flow_mismatch"));
  });

  it("places a merged address at the visible companion even when the zero-width stub comes first", () => {
    const source = cleanSourceFile("tests/fixtures/route-validation/compact-procurement-layout/route-compact-procurement-layout_SysFormTemplate.xml");
    const cell = source.form.layout.rows.flatMap((row) => row.cells)
      .find((item) => item.references.some((ref) => ref.referenceId === "fd_department.name"));
    const stub = cell.references.find((ref) => ref.referenceId === "fd_department");
    const display = cell.references.find((ref) => ref.referenceId === "fd_department.name");
    cell.references = [stub, display];
    const items = new Map(cell.contentFlow.items.map((item) => [item.referenceId, item]));
    cell.contentFlow = { lines: [[stub.referenceId], [display.referenceId]], items: [items.get(stub.referenceId), items.get(display.referenceId)] };
    const draft = draftSourceDraft(source);
    const target = draft.form.layout.mkTree.flatMap((row) => row.children).find((item) => item.refIds.includes("fd_department"));
    assert.deepEqual(target.contentFlow.lines, [[], ["fd_department"]]);
    assert.deepEqual(target.contentFlow.items[0].width, { value: 300, unit: "px" });
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
    assert.equal(checkTrust(source, trusted).ok, true, JSON.stringify(checkTrust(source, trusted).diagnostics));
  });

  it("accepts reordered object keys without accepting reordered flow items", () => {
    const source = sourceForm();
    const trusted = createTrustedMigrationDsl(source, draftSourceDraft(source), { externalAgentReviewed: true });
    const cell = trusted.form.layout.mkTree[0].children[0];
    cell.contentFlow = {
      items: cell.contentFlow.items.map((item) => item.width
        ? { width: { unit: item.width.unit, value: item.width.value }, referenceId: item.referenceId }
        : item),
      lines: cell.contentFlow.lines
    };
    assert.equal(checkTrust(source, trusted).ok, true);
    cell.contentFlow.items.reverse();
    assert.equal(checkTrust(source, trusted).ok, false);
  });

  it("rejects a conflicting native unit even when the correct fallback text remains", () => {
    const source = sourceForm();
    const trusted = createTrustedMigrationDsl(source, draftSourceDraft(source), { externalAgentReviewed: true });
    const sourceUnit = source.form.controls.find((field) => field.id === "fd_unit");
    trusted.form.fields.find((field) => field.id === "fd_quantity").props.unit = "袋";
    trusted.form.fields.push({
      id: sourceUnit.id, title: "件", type: "description", componentId: "xform-description",
      props: { content: "件" }, sourceProps: sourceUnit.sourceProps, sourceRef: sourceUnit.sourceRef
    });
    const cell = trusted.form.layout.mkTree[0].children[0];
    cell.refIds.splice(2, 0, sourceUnit.id);
    cell.contentFlow.lines[0].push(sourceUnit.id);
    cell.contentFlow.items.splice(2, 0, { referenceId: sourceUnit.id });
    const result = checkTrust(source, trusted);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((item) => item.code === "trust.form.presentation_unit_mismatch"));
  });

  it("compares native and fallback unit text after trimming HTML edge whitespace", () => {
    const source = sourceForm();
    const trusted = createTrustedMigrationDsl(source, draftSourceDraft(source), { externalAgentReviewed: true });
    trusted.form.fields.find((field) => field.id === "fd_quantity").props.unit = " 件  ";
    trusted.form.fields.find((field) => field.id === "fd_result_unit").props.content = "份            ";
    const result = checkTrust(source, trusted);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  });

  it("keeps main fields and same-named detail columns in separate source scopes", () => {
    const source = sourceFormWithDetails();
    const trusted = createTrustedMigrationDsl(source, draftSourceDraft(source), { externalAgentReviewed: true });
    assert.equal(checkTrust(source, trusted).ok, true, JSON.stringify(checkTrust(source, trusted).diagnostics));
    const main = trusted.form.fields.find((field) => field.id === "fd_quantity");
    const firstTable = trusted.form.fields.find((field) => field.id === "fd_detail_a");
    const secondTable = trusted.form.fields.find((field) => field.id === "fd_detail_b");
    delete firstTable.columns[0].props.hiddenLabel;
    assert.equal(main.props.hiddenLabel, true);
    assert.equal(secondTable.columns[0].props.hiddenLabel, true);
    const result = checkTrust(source, trusted);
    assert.equal(result.ok, false);
    const mismatch = result.diagnostics.find((item) => item.code === "trust.form.presentation_hidden_label_mismatch");
    assert.equal(mismatch.details.sourceRef, source.form.detailTables[0].columns[0].sourceRef);
  });

  it("preserves a source-backed hidden title on a detail-table wrapper", () => {
    const source = sourceFormWithDetails();
    const table = source.form.detailTables[0];
    table.sourceProps.layoutCell = { hiddenLabel: true };
    const trusted = createTrustedMigrationDsl(source, draftSourceDraft(source), { externalAgentReviewed: true });
    const target = trusted.form.fields.find((field) => field.id === table.id);
    assert.equal(target.props.hiddenLabel, true);
    assert.equal(checkTrust(source, trusted).ok, true);
    delete target.props.hiddenLabel;
    assert.ok(checkTrust(source, trusted).diagnostics.some((item) =>
      item.code === "trust.form.presentation_hidden_label_mismatch" && item.details.sourceRef === table.sourceRef));
  });

  it("rejects inconsistent flow references and invalid dimensions at the DSL boundary", () => {
    const draft = draftSourceDraft(sourceForm());
    const cell = draft.form.layout.mkTree[0].children[0];
    cell.contentFlow = { lines: [["unknown"]], items: [{ referenceId: "unknown", width: { value: -5, unit: "px" } }] };
    const result = checkDraft(draft);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((item) => item.code === "dsl.form.layout.content_flow_invalid"));
  });
});

function sourceFormWithDetails() {
  const source = sourceForm();
  for (const tableId of ["fd_detail_a", "fd_detail_b"]) {
    const table = {
      id: tableId, title: tableId, sourceType: "detailTable", sourceProps: {},
      sourceRef: `source.form.detail.${tableId}`,
      columns: [{
        id: "fd_quantity", title: "明细数量", sourceType: "number",
        sourceRef: `source.form.detail.${tableId}.column.fd_quantity`,
        sourceProps: { layoutCell: { hiddenLabel: true } }
      }]
    };
    source.form.detailTables.push(table);
    source.form.layout.rows.push({
      id: `row-${tableId}`, sourceRef: `source.form.layout.${tableId}`, columns: 1,
      cells: [{
        id: `cell-${tableId}`, sourceRef: `source.form.layout.${tableId}.cell`, column: 0, colspan: 1,
        references: [{ referenceId: tableId, referenceType: "detailTable", sourceRef: table.sourceRef }]
      }]
    });
  }
  return source;
}
