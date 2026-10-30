import assert from "node:assert/strict";
import { it } from "node:test";
import { runInNewContext } from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeScalarFormRules } from "../helpers/native-scalar-form-rules.js";
import { prepareStaticDescriptionVisibility } from "../../src/executor/static-description-visibility-plan.js";

const fixture = "tests/fixtures/route-validation/static-description-visibility/visibility_SysFormTemplate.xml";
function setup() {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source), config = xformConfig(prepareSample(draft).update);
  const tableName = config.dataModel.find(model => model.fdType === "main").fdTableName;
  const attr = JSON.parse(config.attribute.formAttr), ruleId = "linkage.fd_payment.contains.C.load";
  const condition = { condNodeType: "condition", fieldName: "fd_payment", fieldKey: "fd_payment", label: "付款方式", tableType: "main", type: "main",
    operate: "include", valueType: "fixed", value: { script: "C" }, fieldType: "current", tableFieldID: "table", fieldID: "field", OperaterID: "op", formulaID: "formula", valueTypeID: "value", tableTypeID: "type" };
  const result = { fieldName: "fd_note", fieldKey: "fd_note", label: "说明", tableType: "main", type: "main", displayFlag: "display", title: "",
    fieldID: "result", actionID: "action", tID: "table", tableTypeID: "type" };
  const prefix = `mk-migrate-agent-v2:${ruleId}`;
  const rule = (suffix, conditionValue, resultValue) => ({ id: `rule-${suffix}`, ruleName: `${prefix}:${suffix}:display`, active: true,
    condition: "1", choices: { items: [structuredClone(conditionValue)] }, result: [structuredClone(resultValue)] });
  const yes = rule("when", condition, result), no = rule("else", { ...condition, operate: "notInclude" }, { ...result, displayFlag: "hide" });
  attr.formRule.display = [yes, no];
  const action = { id: "source-category-change", name: "onChange", function: 'function onChange(value) { if (value.indexOf("C") >= 0) MKXFORM.setFieldAttr("fd_note", 5); else MKXFORM.setFieldAttr("fd_note", 4); }' };
  attr.controlAction = { control: { [`${tableName}.fd_payment`]: { onChange: [action] } }, global: {} };
  config.attribute.formAttr = JSON.stringify(attr);
  const previous = structuredClone(attr), reviewed = structuredClone(attr);
  reviewed.controlAction.control[`${tableName}.fd_payment`].onChange[0].function = action.function.replace("value.indexOf(", '(value === null ? "" : value).indexOf(');
  const init = structuredClone(no); init.id = "rule-initial"; init.ruleName = `mk-migrate-agent-v2:initial.${ruleId}:when:display`;
  init.choices.items[0] = { ...condition, fieldName: "fd_initial", fieldKey: "fd_initial", operate: "empty", value: { script: "" } };
  reviewed.formRule.display = [init];
  return { source, config, previous, reviewed, initialization: { version: 1, anchorId: "fd_initial", entries: [{ ruleId, changeActionId: action.id }] },
    tableName, projectionTableName: tableName, anchorId: "fd_fixed_header" };
}

it("uses a present static description for a designer-valid, initial-only rule without changing data models or views", () => {
  const input = setup(), before = structuredClone(input.config), result = prepareStaticDescriptionVisibility(input);
  const attr = JSON.parse(result.config.attribute.formAttr), rule = attr.formRule.display[0];
  assert.deepEqual(result.changes, { anchorId: "fd_fixed_header", previousRules: 2, initializationRules: 1, changedActions: 1 });
  assert.equal(rule.condition, "2");
  assert.deepEqual(rule.choices.items.map(item => [item.fieldName, item.operate]), [["fd_fixed_header", "empty"], ["fd_fixed_header", "notEmpty"]]);
  assert.deepEqual(result.config.dataModel, before.dataModel); assert.deepEqual(result.config.viewModel, before.viewModel);
  assert.equal(input.source.form.controls.find(field => field.id === "fd_fixed_header").sourceType, "description");
  for (const initial of [undefined, null, "", "heading", 0, false, [], ["x"]]) {
    const runtime = nativeScalarFormRules(result.config); runtime.initialize({ fd_fixed_header: initial });
    assert.equal(runtime.visible("fd_note"), false, `initial value: ${String(initial)}`);
    const fn = runInNewContext(`(${attr.controlAction.control[`${input.tableName}.fd_payment`].onChange[0].function})`, { MKXFORM: runtime.runtime.MKXFORM });
    for (const [value, visible] of [["C", true], ["A", false], [null, false], ["C", true]]) {
      fn(value); runtime.change("fd_payment", value); assert.equal(runtime.effects.length, 0); assert.equal(runtime.visible("fd_note"), visible);
    }
  }
});

for (const [name, mutate] of [
  ["stored or writable anchor", x => { x.config.dataModel[0].fdFields.find(f => f.fdName === x.anchorId).fdIsStored = true; }],
  ["missing mobile anchor", x => { const v = JSON.parse(x.config.viewModel[0].fdConfig); v.view.render.mobile = []; x.config.viewModel[0].fdConfig = JSON.stringify(v); }],
  ["anchor used by an action", x => { const a = JSON.parse(x.config.attribute.formAttr); a.controlAction.global.x = { id: "x", function: 'function f(){MKXFORM.setValue("fd_fixed_header",1)}' }; x.config.attribute.formAttr = JSON.stringify(a); x.previous.controlAction = structuredClone(a.controlAction); }],
  ["current rule drift", x => { const a = JSON.parse(x.config.attribute.formAttr); a.formRule.display[0].active = false; x.config.attribute.formAttr = JSON.stringify(a); }],
  ["reviewed hidden result drift", x => { x.reviewed.formRule.display[0].result[0].displayFlag = "display"; }],
  ["reviewed unrelated script change", x => { x.reviewed.controlAction.control[`${x.tableName}.fd_payment`].onChange[0].function += "\nextra()"; }]
]) it(`fails closed for ${name}`, () => { const input = setup(); mutate(input); assert.throws(() => prepareStaticDescriptionVisibility(input)); });
