import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { prepareChoiceOtherDesignSync } from "../../src/executor/choice-other-design-sync-plan.js";

const nodes = n => !n || typeof n !== "object" ? [] : [n, ...(n.children || []).flatMap(nodes)];
function fixture() {
  const dsl = draftSourceDraft(cleanSourceFile("tests/fixtures/route-validation/choice-other-wrap/choice-other-wrap_SysFormTemplate.xml"));
  for (const field of dsl.form.fields) delete field.otherPresentation;
  const template = prepareSample(dsl).update, config = xformConfig(template);
  const view = JSON.parse(config.viewModel[0].fdConfig);
  for (const scene of ["desktop", "mobile"]) for (const n of view.view.render[scene].flatMap(nodes)) {
    const i = n.children?.findIndex(c => c.controlProps?.className?.startsWith("mk-choice-other-flow-"));
    if (i >= 0) { const items = n.children[i].children.slice(1); for (const c of items) c.controlProps.className = "mk-adaptive-main-field"; items[0].controlProps.style.flex = "1 1 0"; n.children.splice(i, 1, ...items); }
  }
  config.viewModel[0].fdConfig = JSON.stringify(view);
  Object.assign(template, { fdStatus: 1, fdAlterTime: 100 });
  Object.assign(template.mechanisms["sys-xform"], { fdConfig: JSON.stringify(config), fdStatus: "official", fdVersionId: "current-version", fdAlterTime: 100 });
  Object.assign(template.mechanisms.lbpmTemplate[0], { fdEntityId: template.fdId, fdStatus: "published", isDraft: false, fdContent: "protected graph", fdAlterTime: 100 });
  const officialForm = { fdId: "current-version", fdXForm: { fdId: template.fdId }, fdEntityId: template.fdId, fdTableName: template.fdTableName, fdStatus: "official", fdConfig: "protected official config" };
  return { before: { template, workflow: structuredClone(template.mechanisms.lbpmTemplate[0]), officialForm }, priorDsl: dsl, dsl, categoryId: "category-id" };
}

it("plans only design view changes using the native metadata update transport", () => {
  const input = fixture(), p = prepareChoiceOtherDesignSync(input);
  assert.equal(p.changes.length, 2);
  assert.equal(p.payload.fdStatus, 1);
  assert.equal(p.payload.mechanisms.lbpmTemplate[0].isDraft, false);
  assert.equal(Object.hasOwn(p.payload.mechanisms.lbpmTemplate[0], "fdContent"), false);
  assert.equal(p.verify(p.expected).ok, true);
  assert.equal(prepareChoiceOtherDesignSync({ ...input, before: p.expected }).changed, false);
});

for (const [name, mutate] of [
  ["official config", b => { b.officialForm.fdConfig += "changed"; }],
  ["official version", b => { b.template.mechanisms["sys-xform"].fdVersionId = "new-version"; }],
  ["workflow graph", b => { b.workflow.fdContent = "changed"; }],
  ["bound workflow", b => { b.template.mechanisms.lbpmTemplate[0].fdContent = "changed"; }],
  ["publication state", b => { b.template.fdStatus = 0; }],
  ["field config", b => { const c = xformConfig(b.template); c.dataModel[0].fdFields[0].fdDisplay = false; b.template.mechanisms["sys-xform"].fdConfig = JSON.stringify(c); }],
  ["permissions", b => { const c = xformConfig(b.template); c.auth = []; b.template.mechanisms["sys-xform"].fdConfig = JSON.stringify(c); }]
]) it(`rejects readback changes outside design layout: ${name}`, () => {
  const p = prepareChoiceOtherDesignSync(fixture()), after = structuredClone(p.expected); mutate(after);
  assert.equal(p.verify(after).ok, false);
});

it("accepts only nondecreasing native update timestamps", () => {
  const p = prepareChoiceOtherDesignSync(fixture()), after = structuredClone(p.expected);
  after.template.fdAlterTime = 101; after.template.mechanisms["sys-xform"].fdAlterTime = 102;
  assert.equal(p.verify(after).ok, true);
  after.template.fdAlterTime = 99;
  assert.equal(p.verify(after).ok, false);
});

it("normalizes only same-model empty deletion initialization and bounded native audit timestamps", () => {
  const p = prepareChoiceOtherDesignSync(fixture()), after = structuredClone(p.expected), c = xformConfig(after.template);
  after.template.fdAlterTime = 101; after.template.mechanisms["sys-xform"].fdAlterTime = 104;
  after.workflow.fdAlterTime = 105; after.template.mechanisms.lbpmTemplate[0].fdAlterTime = 105;
  c.dataModel[0].fdAlterTime = 102; c.dataModel[0].fdDeletedFields = [];
  after.template.mechanisms["sys-xform"].fdConfig = JSON.stringify(c);
  assert.equal(p.verify(after).ok, true);
  for (const mutate of [m => { m.fdDeletedFields = ["existing-field"]; }, m => { m.fdAlterTime = 99; },
    m => { m.fdAlterTime = 106; }, m => { m.fdId = "different"; }, m => { m.fdFields[0].fdLength = 999; }]) {
    const bad = structuredClone(after), config = xformConfig(bad.template); mutate(config.dataModel[0]);
    bad.template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    assert.equal(p.verify(bad).ok, false);
  }
});

it("rejects mismatching form tables, workflow ownership and draft/publication flags before planning", () => {
  for (const mutate of [i => { i.before.officialForm.fdTableName = "another-table"; },
    i => { i.before.workflow.fdEntityId = "another-template"; },
    i => { i.before.template.mechanisms.lbpmTemplate[0].isDraft = true; }]) {
    const input = fixture(); mutate(input); assert.throws(() => prepareChoiceOtherDesignSync(input));
  }
});
