import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { choiceOtherRevealBindings } from "../../src/dsl/choice-other-reveal.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { prepareChoiceOtherRevealConfig } from "../../src/executor/choice-other-reveal-update-plan.js";

const fixtures = [
  "tests/fixtures/route-validation/choice-other-wrap/choice-other-wrap_SysFormTemplate.xml",
  "tests/fixtures/route-validation/checkbox-other-compatible/compatible_SysFormTemplate.xml",
  "tests/fixtures/route-validation/choice-other-select/choice-other-select_SysFormTemplate.xml"
];
const nodes = n => !n || typeof n !== "object" ? [] : [n, ...(n.children || []).flatMap(nodes)];
function setup(path) {
  const form = draftSourceDraft(cleanSourceFile(path)).form;
  const prior = draftSourceDraft(cleanSourceFile(path));
  for (const field of prior.form.fields) delete field.otherPresentation;
  const prepared = prepareSample(prior), config = xformConfig(prepared.update);
  return { config, form, tableName: prepared.update.fdTableName, pairs: choiceOtherRevealBindings(form) };
}

for (const path of fixtures) it(`plans a protected, source-bound Other reveal: ${path}`, () => {
  const input = setup(path), before = structuredClone(input.config);
  const plan = prepareChoiceOtherRevealConfig(input);
  assert.equal(plan.changes.length, input.pairs.length * 2);
  assert.deepEqual(input.config, before);
  const protectedConfig = structuredClone(plan.config);
  protectedConfig.viewModel = structuredClone(before.viewModel);
  protectedConfig.attribute.formAttr = before.attribute.formAttr;
  assert.deepEqual(protectedConfig, before);
  assert.equal(prepareChoiceOtherRevealConfig({ ...input, config: plan.config }).changed, false);
  assert.ok(plan.changes.every(change => ["desktop", "mobile"].includes(change.scene)));
});

it("wraps an existing ungrouped checkbox Other pair without changing stored fields", () => {
  const input = setup(fixtures[0]), before = structuredClone(input.config);
  for (const model of input.config.viewModel) {
    const view = JSON.parse(model.fdConfig);
    for (const scene of ["desktop", "mobile"]) for (const node of view.view.render[scene].flatMap(nodes)) {
      const index = node.children?.findIndex(child => child.controlProps?.className?.startsWith("mk-choice-other-flow-"));
      if (index >= 0) {
        const items = node.children[index].children.slice(1);
        for (const item of items) item.controlProps.className = "mk-adaptive-main-field";
        items[0].controlProps.style.flex = "1 1 0";
        node.children.splice(index, 1, ...items);
      }
    }
    model.fdConfig = JSON.stringify(view);
  }
  const ungrouped = structuredClone(input.config), plan = prepareChoiceOtherRevealConfig(input);
  assert.equal(plan.changes.length, 2);
  assert.deepEqual(plan.config.dataModel, before.dataModel);
  assert.deepEqual(input.config, ungrouped);
});

for (const [name, mutate] of [
  ["unapproved pair", i => { i.pairs = []; }],
  ["changed option", i => { const field = i.config.dataModel.flatMap(m => m.fdFields).find(f => f.fdName === i.pairs[0].choiceId); const a = JSON.parse(field.fdAttribute); a.config.controlProps.options[0].value = "foreign"; field.fdAttribute = JSON.stringify(a); }],
  ["missing note", i => { const field = i.config.dataModel.flatMap(m => m.fdFields).find(f => f.fdName === i.pairs[0].textId); field.fdDisplay = false; }],
  ["existing arbitrary action", i => { const a = JSON.parse(i.config.attribute.formAttr); a.controlAction.global.onLoad = [{ name: "onLoad", function: "function onLoad(){unknownEffect();}" }]; i.config.attribute.formAttr = JSON.stringify(a); }],
  ["non-adjacent wrappers", i => { const v = JSON.parse(i.config.viewModel[0].fdConfig); const all=v.view.render.desktop.flatMap(nodes); const first=i.pairs[0].triggerId; const line=all.find(n => n.children?.some(c => c.children?.[0]?.key === first)); line.children.reverse(); i.config.viewModel[0].fdConfig=JSON.stringify(v); }]
]) it(`blocks a reveal plan with ${name}`, () => {
  const input = setup(fixtures[2]); mutate(input);
  assert.throws(() => prepareChoiceOtherRevealConfig(input));
});
