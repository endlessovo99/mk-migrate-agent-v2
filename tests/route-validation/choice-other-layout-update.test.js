import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig, sampleBaseTemplate } from "../helpers/persistence.js";
import { prepareChoiceOtherLayoutConfig, preparePublishedChoiceOtherLayout } from "../../src/executor/choice-other-layout-update-plan.js";

const nodes = n => !n || typeof n !== "object" ? [] : [n, ...(n.children || []).flatMap(nodes)];
function fixture() {
  const dsl = draftSourceDraft(cleanSourceFile("tests/fixtures/route-validation/choice-other-wrap/choice-other-wrap_SysFormTemplate.xml"));
  for (const field of dsl.form.fields) delete field.otherPresentation;
  const config = xformConfig(prepareSample(dsl).update), priorDsl = structuredClone(dsl);
  delete priorDsl.form.fields.find(f => f.type === "checkbox").sourceProps.otherTextCompanion;
  const view = JSON.parse(config.viewModel[0].fdConfig);
  for (const scene of ["desktop", "mobile"]) for (const node of view.view.render[scene].flatMap(nodes)) {
    const index = node.children?.findIndex(c => c.controlProps?.className?.startsWith("mk-choice-other-flow-"));
    if (index >= 0) {
      const items = node.children[index].children.slice(1);
      for (const item of items) item.controlProps.className = "mk-adaptive-main-field";
      items[0].controlProps.style.flex = "1 1 0";
      node.children.splice(index, 1, ...items);
    }
  }
  config.viewModel[0].fdConfig = JSON.stringify(view);
  return { dsl, priorDsl, config };
}

it("does not extend an existing-template layout update to the new conditional presentation", () => {
  const input = fixture();
  input.dsl = draftSourceDraft(cleanSourceFile("tests/fixtures/route-validation/choice-other-wrap/choice-other-wrap_SysFormTemplate.xml"));
  assert.throws(() => prepareChoiceOtherLayoutConfig(input), /outside the existing-template layout update scope/);
});

it("updates only the proven native view groups, keeping all business configuration exact", () => {
  const input = fixture(), before = structuredClone(input.config), p = prepareChoiceOtherLayoutConfig(input);
  assert.equal(p.changes.length, 2);
  assert.deepEqual(input.config, before, "planner must not mutate snapshots");
  const protectedConfig = structuredClone(p.config); protectedConfig.viewModel = before.viewModel;
  assert.deepEqual(protectedConfig, before);
  assert.equal(prepareChoiceOtherLayoutConfig({ ...input, config: p.config }).changed, false, "already-correct layouts never need a write");
});

for (const [name, mutate] of [
  ["business default", i => { i.dsl.form.fields.find(f => f.type === "text").props.defaultValue.value = "changed"; }],
  ["source options", i => { i.dsl.form.fields.find(f => f.type === "checkbox").props.options.pop(); }],
  ["persisted options", i => { const f = i.config.dataModel.flatMap(m => m.fdFields).find(f => f.fdName === "fd_kind"), a = JSON.parse(f.fdAttribute); a.config.controlProps.options.reverse(); f.fdAttribute = JSON.stringify(a); }],
  ["non-adjacent native fields", i => { const v = JSON.parse(i.config.viewModel[0].fdConfig); const line = v.view.render.desktop.flatMap(nodes).find(n => n.children?.some(c => c.children?.[0]?.key === "fd_kind")); line.children.reverse(); i.config.viewModel[0].fdConfig = JSON.stringify(v); }],
  ["workflow change", i => { i.dsl.workflow = { unexpected: true }; }]
]) it(`blocks an out-of-scope update: ${name}`, () => {
  const input = fixture(); mutate(input);
  assert.throws(() => prepareChoiceOtherLayoutConfig(input));
});

it("previews a bound official version while protecting models, scripts, graph and published identity", () => {
  const input = fixture(), template = sampleBaseTemplate();
  template.fdStatus = 1;
  Object.assign(template.mechanisms["sys-xform"], { fdStatus: "official", fdVersionId: "official-version", fdConfig: JSON.stringify(input.config) });
  Object.assign(template.mechanisms.lbpmTemplate[0], { fdStatus: "published", isDraft: false, fdContent: "unchanged graph" });
  const officialForm = { fdId: "official-version", fdEntityId: template.fdId, fdXForm: { fdId: template.fdId },
    fdStatus: "official", fdTableName: template.fdTableName, fdConfig: JSON.stringify(input.config) };
  const originalView = input.config.viewModel[0];
  originalView.fdFormVersionId = officialForm.fdId;
  originalView.fdXForm = { fdId: template.fdId };
  originalView.fdProfileId = createHash("md5").update(originalView.fdConfig).digest("hex");
  officialForm.fdConfig = JSON.stringify(input.config);
  officialForm.fdCreator = { fdId: "original-actor" };
  officialForm.fdCreateTime = 10;
  officialForm.fdAlterTime = 20;
  const p = preparePublishedChoiceOtherLayout({ ...input, template, officialForm, categoryId: "category-id" });
  const afterForm = { ...officialForm, fdConfig: p.payload.fdConfig };
  assert.equal(p.verify(template, afterForm), true);
  const native = structuredClone(afterForm), nativeConfig = JSON.parse(native.fdConfig), view = nativeConfig.viewModel[0];
  view.fdProfileId = createHash("md5").update(view.fdConfig).digest("hex");
  view.fdCreator = structuredClone(officialForm.fdCreator); view.fdCreateTime = 15;
  native.fdConfig = JSON.stringify(nativeConfig);
  assert.equal(p.verify(template, native), true, "only verified same-view profile and audit initialization may normalize");
  for (const mutate of [v => { v.fdProfileId = "f".repeat(32); }, v => { v.fdCreator.fdId = "unrelated"; },
    v => { v.fdCreateTime = 100; }, v => { v.fdFormVersionId = "another-version"; }]) {
    const bad = structuredClone(native), config = JSON.parse(bad.fdConfig); mutate(config.viewModel[0]); bad.fdConfig = JSON.stringify(config);
    assert.equal(p.verify(template, bad), false);
  }
  for (const mutate of [
    (t, f) => { t.mechanisms.lbpmTemplate[0].fdContent = "changed graph"; },
    (t, f) => { f.fdEntityId = "another template"; },
    (t, f) => { const c = JSON.parse(f.fdConfig); c.dataModel[0].fdFields[0].fdDisplay = false; f.fdConfig = JSON.stringify(c); },
    (t, f) => { t.fdStatus = 0; }
  ]) {
    const t = structuredClone(template), f = structuredClone(afterForm); mutate(t, f);
    assert.equal(p.verify(t, f), false);
  }
});
