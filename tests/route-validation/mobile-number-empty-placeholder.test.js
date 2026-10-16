import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { applyFormPayload } from "../../src/executor/persistence/form-writer.js";
import { prepareSample, sampleBaseTemplate, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/mobile-number-empty-placeholder/mobile-number-empty-placeholder_SysFormTemplate.xml";
const numericIds = ["fd_amount", "fd_locked", "fd_qty", "fd_qty_lock"];
const rawKey = "@elem/xform-m-number###langs###enter";
const stages = () => {
  const source = cleanSourceFile(fixture);
  return { source, draft: draftSourceDraft(source) };
};
const fieldOf = (draft, id) => draft.form.fields.flatMap(field => [field, ...(field.columns || [])]).find(field => field.id === id);
function nativeField(config, id) {
  const found = config.dataModel.flatMap(model => model.fdFields || []).filter(field => field.fdName === id);
  assert.equal(found.length, 1, `one native field for ${id}`);
  return found[0];
}
const propsOf = (config, id) => JSON.parse(nativeField(config, id).fdAttribute).config.controlProps;
function mutateNative(update, id, change) {
  const next = structuredClone(update), config = xformConfig(next);
  const field = nativeField(config, id), attribute = JSON.parse(field.fdAttribute);
  change(attribute.config.controlProps);
  field.fdAttribute = JSON.stringify(attribute);
  next.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  return next;
}
function mutateView(update, change) {
  const next = structuredClone(update), config = xformConfig(next);
  const view = JSON.parse(config.viewModel[0].fdConfig);
  change(view);
  config.viewModel[0].fdConfig = JSON.stringify(view);
  next.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  return next;
}

it("parses genuine main/detail numeric source and retains executable trust and native baseline", () => {
  const { source, draft } = stages();
  const trusted = createTrustedMigrationDsl(source, draft, {
    externalAgentReviewed: true,
    reviewerName: "synthetic mobile number placeholder regression",
    checkedAt: "2026-10-16T00:00:00Z"
  });
  assert.equal(checkDraft(draft).ok, true);
  assert.equal(checkTrust(source, trusted).ok, true);
  assert.equal(checkExecute(trusted).ok, true);
  for (const id of numericIds) {
    assert.equal(fieldOf(draft, id).componentId, "xform-number");
    assert.equal(Object.hasOwn(fieldOf(draft, id).props, "placeholder"), false);
    assert.deepEqual(fieldOf(draft, id).props.defaultValue, { kind: "literal", value: 0 });
  }
  assert.equal(fieldOf(draft, "fd_amount").props.unit, "元");
  assert.equal(fieldOf(draft, "fd_qty").props.precision, 3);
  assert.equal(fieldOf(draft, "fd_qty_lock").props.readOnly, true);
  assert.equal(draft.scripts?.actions?.length || 0, 0);
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("writes an own-present empty mobile hint only for registered numbers while preserving numeric and layout semantics", () => {
  const { draft } = stages(), before = structuredClone(draft);
  const prepared = prepareSample(draft), config = xformConfig(prepared.update);
  for (const [id, precision, readOnly, required, tableType] of [
    ["fd_amount", 2, false, true, "main"], ["fd_locked", 0, true, false, "main"],
    ["fd_qty", 3, false, true, "detail"], ["fd_qty_lock", 0, true, false, "detail"]
  ]) {
    const props = propsOf(config, id);
    assert.equal(props.mobile.type, "@elem/xform-m-number");
    assert.equal(Object.hasOwn(props.mobile, "placeholder"), true, id);
    assert.equal(props.mobile.placeholder, "", id);
    assert.equal(Object.hasOwn(props, "placeholder"), false, `top unchanged: ${id}`);
    assert.equal(Object.hasOwn(props.desktop, "placeholder"), false, `desktop unchanged: ${id}`);
    assert.equal(props.valueType.precision, precision);
    assert.equal(props.showStatus === "readOnly", readOnly);
    assert.equal(props.required === true, required);
    assert.equal(props["$$tableType"], tableType);
    assert.equal(props.showCount, true, `existing native spinner policy: ${id}`);
    assert.equal(props.defaultValueFormulaVO.script, "0");
    const font = JSON.parse(nativeField(config, id).fdFontExtendData);
    assert.equal(font.precision, String(precision));
    assert.equal(font.showCount, true);
    assert.equal(font.defaultValueFormulaVO.script, "0");
  }
  const amount = propsOf(config, "fd_amount");
  assert.match(amount.numberFormat.unit, /^!\{[a-f0-9]+\}$/);
  assert.equal(propsOf(config, "fd_total").expressionFormulaVO.script, "${data.biz.fd_amount} * 2");
  assert.deepEqual(draft, before, "projection must not mutate source-backed fields, layout or business sections");
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("rejects main mobile empty-hint loss, null and the raw component key", () => {
  const prepared = prepareSample(stages().draft);
  for (const [name, change] of [
    ["missing", props => { delete props.mobile.placeholder; }],
    ["null", props => { props.mobile.placeholder = null; }],
    ["raw key", props => { props.mobile.placeholder = rawKey; }],
    ["different mobile target", props => { props.mobile.type = "@elem/xform-m-input"; props.mobile.placeholder = ""; }],
    ["missing with empty top fallback", props => { props.placeholder = ""; delete props.mobile.placeholder; }]
  ]) assert.equal(prepared.verify(mutateNative(prepared.update, "fd_amount", change)).ok, false, name);
});

it("rejects missing, null or raw mobile hints in both editable and readonly detail numbers", () => {
  const prepared = prepareSample(stages().draft);
  for (const id of ["fd_qty", "fd_qty_lock"]) {
    for (const [name, change] of [
      ["missing", props => { delete props.mobile.placeholder; }],
      ["null", props => { props.mobile.placeholder = null; }],
      ["raw key", props => { props.mobile.placeholder = rawKey; }]
    ]) assert.equal(prepared.verify(mutateNative(prepared.update, id, change)).ok, false, `${id}: ${name}`);
  }
});

it("rejects final mobile view-style hint overrides for main and detail numbers", () => {
  const prepared = prepareSample(stages().draft);
  for (const id of ["fd_amount", "fd_qty"]) for (const value of [rawKey, null, "Unrequested hint"]) {
    const changed = mutateView(prepared.update, view => {
      view.controlStyle ||= {};
      view.controlStyle[id] ||= {};
      view.controlStyle[id].mobile = { ...(view.controlStyle[id].mobile || {}), placeholder: value };
    });
    assert.equal(prepared.verify(changed).ok, false, `${id}: ${JSON.stringify(value)}`);
  }
});

it("keeps unsupported explicit numeric hints outside the public DSL without overriding them in pure projection", () => {
  for (const hint of ["Source numeric hint", ""]) {
    const { draft } = stages();
    fieldOf(draft, "fd_amount").props.placeholder = hint;
    const checked = checkDraft(draft);
    assert.equal(checked.ok, false, "number placeholder remains unsupported by the public schema");
    assert.ok(checked.diagnostics.some(item => /placeholder/.test(JSON.stringify(item))));
    // This is a pure writer counterexample, not an accepted execute route.
    const update = applyFormPayload(sampleBaseTemplate(), draft), props = propsOf(xformConfig(update), "fd_amount");
    assert.equal(Object.hasOwn(props.mobile, "placeholder"), false, "a configured DSL hint must not be replaced by the new default");
    assert.equal(Object.hasOwn(props, "placeholder"), false, "do not invent unsupported numeric hint support");
  }
});

it("preserves source text hints and leaves calculate/native non-number targets unchanged", () => {
  const { draft } = stages(), prepared = prepareSample(draft), config = xformConfig(prepared.update);
  assert.equal(checkDraft(draft).ok, true);
  assert.equal(fieldOf(draft, "fd_note").props.placeholder, "Source text hint");
  const input = propsOf(config, "fd_note"), total = propsOf(config, "fd_total");
  assert.equal(input.mobile.type, "@elem/xform-m-input");
  assert.equal(input.placeholder, "Source text hint");
  assert.equal(Object.hasOwn(input.mobile, "placeholder"), false);
  assert.equal(total.mobile.type, "@elem/xform-m-calculate");
  assert.equal(Object.hasOwn(total.mobile, "placeholder"), false);
  assert.equal(Object.hasOwn(total, "placeholder"), false);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("accepts an equivalent explicit empty final mobile overlay without changing desktop hints", () => {
  const prepared = prepareSample(stages().draft);
  const changed = mutateView(prepared.update, view => {
    view.controlStyle ||= {};
    for (const id of numericIds) {
      view.controlStyle[id] ||= {};
      view.controlStyle[id].mobile = { ...(view.controlStyle[id].mobile || {}), placeholder: "" };
    }
  });
  const config = xformConfig(changed);
  for (const id of numericIds) assert.equal(Object.hasOwn(propsOf(config, id).desktop, "placeholder"), false);
  assert.equal(prepared.verify(changed).ok, true);
});

it("completes the guarded fake number route through readback and record", async () => {
  const result = await runRouteCase("mobile-number-empty-placeholder-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.readback.invariantVersion, 39);
  assert.equal(result.execution.transferRecord.status, "recorded");
});
