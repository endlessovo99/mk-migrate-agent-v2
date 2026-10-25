import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sourceDraftFromLegacyDsl } from "../../src/translator/source-draft.js";
import { translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const directory = "tests/fixtures/route-validation/detail-unbound-caption";
const cases = [
  { name: "base", table: "line_items", quantity: "quantity", price: "unit_price", amount: "amount",
    total: "computed_total", hidden: "hidden_cache", header: "amount_header", title: "金额", display: "计算总价" },
  { name: "renamed", table: "cargo_rows", quantity: "units", price: "rate", amount: "charge",
    total: "extended_value", hidden: "hidden_token", header: "charge_heading", title: "申报金额", display: "校核总额" }
];
const column = (draft, ids, id) => draft.form.fields.find(field => field.id === ids.table).columns.find(field => field.id === id);
const sourceColumn = (source, ids, id) => source.form.detailTables.find(table => table.id === ids.table).columns.find(field => field.id === id);
function stages(name = "base") {
  const source = cleanSourceFile(`${directory}/${name}_SysFormTemplate.xml`);
  return { source, draft: draftSourceDraft(source) };
}
function variant(change) {
  const properties = parseRootHashMapStringPuts(readFileSync(`${directory}/base_SysFormTemplate.xml`, "utf8"));
  const original = properties.fdDesignerHtml;
  properties.fdDesignerHtml = change(original);
  assert.notEqual(properties.fdDesignerHtml, original, "The counterexample must change source markup");
  const encode = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const xml = '<java><object class="java.util.HashMap">' + Object.entries(properties)
    .map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`)
    .join("") + "</object></java>";
  const source = sourceDraftFromLegacyDsl(translateSysFormTemplateXml(xml));
  return { source, draft: draftSourceDraft(source) };
}
function trusted(source, draft) {
  return createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true,
    reviewerName: "detail unbound caption fixture", checkedAt: "2026-10-25T00:00:00.000Z" });
}

for (const ids of cases) {
  it(`keeps a calculation's physical detail header instead of a stale disabled binding (${ids.name})`, () => {
    const { source, draft } = stages(ids.name), original = sourceColumn(source, ids, ids.total);
    assert.equal(original.title, ids.title);
    assert.deepEqual(original.sourceProps.detailHeaderCaption, {
      id: ids.header, content: ids.title, relation: "same-detail-column-header"
    });
    assert.equal(original.sourceProps.designerValues._label_bind, "false");
    assert.notEqual(original.sourceProps.designerValues._label_bind_id, ids.header);
    assert.deepEqual(original.sourceProps.displayText, {
      content: ids.display, relation: "unbound-detail-control-display-text-distinct-from-header"
    });
    assert.equal(column(draft, ids, ids.total).title, ids.title);
    assert.equal(checkTrust(source, trusted(source, draft)).ok, true);
  });
}

for (const ids of [
  { name: "base", table: "address_rows", display: "selected_org.name", selector: "selected_org",
    note: "free_note", header: "current_address_header", title: "调入部门", oldTitle: "历史列" },
  { name: "renamed", table: "assignment_rows", display: "chosen_department.name", selector: "chosen_department",
    note: "extra_comment", header: "destination_heading", title: "目标部门", oldTitle: "原列" }
]) {
  it(`does not change address/input titles or activate an unrelated composite fold (${ids.name})`, () => {
    const { source, draft } = stages(ids.name), table = draft.form.fields.find(field => field.id === ids.table);
    const selector = sourceColumn(source, ids, ids.selector);
    assert.equal(selector.sourceProps.designerType, "address");
    assert.equal(selector.sourceProps.designerValues._label_bind, "false");
    assert.equal(selector.sourceProps.detailHeaderCaption.id, ids.header);
    assert.equal(selector.sourceProps.detailHeaderCaption.content, ids.title);
    assert.equal(selector.title, ids.oldTitle, "Address semantics remain outside the proven calculation route");
    assert.deepEqual(table.columns.map(field => [field.id, field.title, field.componentId]), [
      [ids.display, ids.title, "xform-input"], [ids.selector, ids.oldTitle, "xform-address"],
      [ids.note, ids.oldTitle, "xform-input"]
    ]);
    for (const field of table.columns) {
      assert.notEqual(field.dataOnly, true, field.id);
      assert.equal(field.props.required, false, field.id);
      assert.equal(field.sourceProps.legacyDetailComposite, undefined, field.id);
    }
    assert.equal(column(draft, ids, ids.display).sourceProps.designerValues.width, "95");
    assert.equal(column(draft, ids, ids.selector).sourceProps.designerValues.width, "0");
    assert.equal(column(draft, ids, ids.note).sourceProps.designerValues._label_bind, "false");
  });
}

it("does not change enabled bindings or require an inactive binding to identify the physical header", () => {
  for (const binding of [
    '_label_bind:"true",_label_bind_id:"price_header"',
    '_label_bind:"false",_label_bind_id:"missing_header"',
    '_label_bind:"false",_label_bind_id:""'
  ]) {
    const { source, draft } = variant(html => html.replace(
      'id:"computed_total",_label_bind:"false",_label_bind_id:"price_header"', `id:"computed_total",${binding}`
    ));
    assert.equal(sourceColumn(source, cases[0], "computed_total").title, "金额");
    assert.equal(column(draft, cases[0], "computed_total").title, "金额");
  }
});

it("keeps the existing title-row binding fallback when no physical column caption is available", () => {
  const { source, draft } = variant(html => html.replace(
    '<label fd_type="textLabel" fd_values=\'{id:"amount_header",content:"金额"}\'>金额</label>', "金额"
  ));
  const original = sourceColumn(source, cases[0], "computed_total");
  assert.equal(original.sourceProps.detailHeaderCaption, undefined);
  assert.equal(original.title, "单价");
  assert.equal(column(draft, cases[0], "computed_total").title, "单价");
  assert.equal(original.sourceProps.displayText.content, "计算总价");
});

it("preserves every field, its order, visibility, source width, permissions and calculation binding", () => {
  for (const ids of cases) {
    const { source, draft } = stages(ids.name), table = draft.form.fields.find(field => field.id === ids.table);
    assert.deepEqual(table.columns.map(field => field.id), [ids.quantity, ids.price, ids.amount, ids.total, ids.hidden]);
    assert.deepEqual(table.columns.map(field => field.id), source.form.detailTables[0].columns.map(field => field.id));
    for (const field of table.columns) {
      assert.deepEqual(field.sourceProps.designerValues, sourceColumn(source, ids, field.id).sourceProps.designerValues);
    }
    const total = column(draft, ids, ids.total), hidden = column(draft, ids, ids.hidden);
    assert.equal(total.sourceProps.designerValues.width, "1");
    assert.equal(total.componentId, "xform-calculate");
    assert.notEqual(total.dataOnly, true);
    assert.equal(total.props.readOnly, true);
    assert.notEqual(total.props.required, true);
    assert.equal(total.props.calculation.expression, `$${ids.quantity}$ * $${ids.price}$`);
    assert.deepEqual(total.props.calculation.fieldIds, [ids.quantity, ids.price]);
    assert.equal(column(draft, ids, ids.price).props.calculation.expression, `$${ids.amount}$ / $${ids.quantity}$`);
    assert.equal(column(draft, ids, ids.amount).componentId, "xform-number");
    assert.equal(column(draft, ids, ids.amount).props.required, true);
    assert.equal(hidden.componentId, "xform-hidden");
    assert.equal(hidden.sourceProps.hardHidden, true);
    assert.equal(hidden.sourceProps.designerValues.width, "0");
    // This narrow title fix does not claim native same-cell detail composition.
    assert.equal(total.sourceProps.legacyDetailComposite, undefined);
  }
});

it("retains the source readonly trust boundary after correcting the title", () => {
  const { source, draft } = stages(), candidate = trusted(source, draft);
  column(candidate, cases[0], "computed_total").props.readOnly = false;
  const checked = checkTrust(source, candidate);
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some(item => item.code === "trust.form.read_only_source_mismatch"));
  assert.equal(sourceColumn(source, cases[0], "computed_total").sourceProps.designerValues.readOnly, "true");
});

it("projects the corrected native title with unchanged formula identities and hidden controls", () => {
  const { draft } = stages(), prepared = prepareSample(draft), config = xformConfig(prepared.update);
  const model = config.dataModel.find(item => item.fdCode === "line_items");
  const total = model.fdFields.find(field => field.fdName === "computed_total");
  const props = JSON.parse(total.fdAttribute).config.controlProps;
  assert.equal(total.fdLabel, "金额");
  assert.equal(props.title, "金额");
  assert.equal(props.expressionFormulaVO.script, "${data.biz.line_items.quantity} * ${data.biz.line_items.unit_price}");
  assert.deepEqual(props.expressionFormulaVO.varIds, ["line_items.quantity", "line_items.unit_price"]);
  const formula = JSON.parse(config.attribute.formAttr).formRule.compute
    .flatMap(rule => rule.choices.items).find(item => item.fieldKey === props.id);
  assert.deepEqual(formula.value, props.expressionFormulaVO);
  assert.equal(config.sign.formula["computed_total.expressionFormulaVO"], formula.value.script);
  const hidden = JSON.parse(model.fdFields.find(field => field.fdName === "hidden_cache").fdAttribute).config;
  assert.equal(hidden.type, "hidden");
  assert.equal(hidden.controlProps.hidden, true);
  assert.equal(prepared.verify(prepared.update).ok, true);

  for (const mutation of ["title", "formula"]) {
    const changed = structuredClone(prepared.update), native = xformConfig(changed);
    const field = native.dataModel.find(item => item.fdCode === "line_items").fdFields.find(item => item.fdName === "computed_total");
    const attr = JSON.parse(field.fdAttribute);
    if (mutation === "title") {
      field.fdLabel = "单价";
      attr.config.controlProps.title = "单价";
    } else {
      // Calculation readback observes the native compute rule, not the control mirror.
      const formAttr = JSON.parse(native.attribute.formAttr);
      const formula = formAttr.formRule.compute.flatMap(rule => rule.choices.items)
        .find(item => item.fieldKey === attr.config.controlProps.id);
      formula.value.script = "${data.biz.line_items.quantity}";
      native.attribute.formAttr = JSON.stringify(formAttr);
    }
    field.fdAttribute = JSON.stringify(attr);
    changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(native);
    assert.equal(prepared.verify(changed).ok, false, mutation);
  }
});
