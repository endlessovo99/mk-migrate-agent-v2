import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Digest } from "../agent-review/digest.js";
import { choiceOtherFlowGroups, buildChoiceOtherGroup, observeChoiceOtherGroup } from "./persistence/choice-other-layout.js";
import { usesAdaptiveLayout } from "../dsl/layout-sizing.js";
import { protectedTemplate, protectedOfficial, configWithoutViewAudit } from "./published-form-patch.js";

const nodes = node => !node || typeof node !== "object" ? [] : [node, ...(node.children || []).flatMap(nodes)];
const same = (a, b) => sha256Digest(a ?? null) === sha256Digest(b ?? null);

/** Pure source-bound view patch. No lifecycle transition, models, scripts or auth changes. */
export function prepareChoiceOtherLayoutConfig({ config, priorDsl, dsl }) {
  assert.ok(![priorDsl, dsl].some(value => (value?.form?.fields || []).some(field => field.otherPresentation)),
    "conditional Other presentation is outside the existing-template layout update scope");
  const expected = structuredClone(dsl.form);
  for (const field of expected.fields) {
    const old = priorDsl.form.fields.find(f => f.id === field.id);
    assert.ok(old, "existing field identity required");
    if (old.sourceProps?.otherTextCompanion) field.sourceProps.otherTextCompanion = structuredClone(old.sourceProps.otherTextCompanion);
    else delete field.sourceProps?.otherTextCompanion;
  }
  assert.ok(same(expected, priorDsl.form), "only source companion facts may differ");
  for (const key of ["template", "workflow", "scripts", "formRules"]) assert.ok(same(priorDsl[key], dsl[key]), `protected DSL ${key} changed`);
  const groups = dsl.form.layout.mkTree.flatMap(row => (row.children || []).flatMap(cell =>
    cell.contentFlow ? choiceOtherFlowGroups(cell.contentFlow, dsl.form.fields) : []));
  const next = structuredClone(config), changes = [];
  assert.ok(groups.length, "no proven layout companion");
  const fields = config.dataModel.flatMap(m => m.fdFields || []);
  for (const group of groups) for (const id of group.referenceIds) {
    const source = dsl.form.fields.find(f => f.id === id), native = fields.filter(f => f.fdName === id);
    assert.equal(native.length, 1, "ambiguous persisted field identity");
    const props = JSON.parse(native[0].fdAttribute).config.controlProps;
    assert.equal(native[0].fdDisplay, true, "original field must remain rendered");
    if (["checkbox", "radio"].includes(source.type)) assert.deepEqual(props.options.map(o => ({ label: o.label, value: o.value })), source.props.options.map(o => ({ label: o.label, value: o.value })), "persisted source options drifted");
  }
  for (const [viewIndex, model] of next.viewModel.entries()) {
    const view = JSON.parse(model.fdConfig);
    for (const scene of ["desktop", "mobile"]) for (const group of groups) {
      const all = view.view.render[scene].flatMap(nodes);
      const existing = all.map(observeChoiceOtherGroup).filter(Boolean);
      assert.ok(existing.every(entry => !entry.invalid), "malformed current companion layout");
      if (existing.some(entry => same(entry.group, { referenceIds: group.referenceIds, mode: group.mode, width: group.width }))) continue;
      const [choiceId, textId] = group.referenceIds;
      const wrappers = group.referenceIds.map(id => all.filter(n => n.type === "div" && n.kind === "container" && n.children?.length === 1 && n.children[0].key === id));
      assert.ok(wrappers.every(items => items.length === 1), "actual original field wrappers must be unique");
      const [first, second] = wrappers.map(items => items[0]);
      const parents = all.filter(n => n.children?.includes(first) && n.children?.includes(second));
      assert.equal(parents.length, 1, "source companions must share an actual native line");
      const parent = parents[0], index = parent.children.indexOf(first);
      assert.equal(parent.children[index + 1], second, "source companion order changed");
      assert.deepEqual(parent.controlProps.style, { display: "flex", flexWrap: "wrap", alignItems: "center", minWidth: 0 });
      assert.ok([undefined, "mk-adaptive-main-field"].includes(first.controlProps.className));
      assert.ok([undefined, "mk-adaptive-main-field"].includes(second.controlProps.className));
      const items = structuredClone([first, second]);
      if (usesAdaptiveLayout(dsl.form)) items[0].controlProps.style.flex = "0 1 auto";
      parent.children.splice(index, 2, buildChoiceOtherGroup(group, items));
      changes.push({ viewIndex, scene, choiceId, textId, mode: group.mode });
    }
    model.fdConfig = JSON.stringify(view);
  }
  // No opaque configuration component can be changed through this planner.
  const protectedConfig = structuredClone(next);
  protectedConfig.viewModel = structuredClone(config.viewModel);
  assert.ok(same(protectedConfig, config));
  return { config: next, changes, groups, changed: changes.length > 0 };
}

/** Preview only. Existing published-form write gates are deliberately unchanged. */
export function preparePublishedChoiceOtherLayout({ template, officialForm, priorDsl, dsl, categoryId }) {
  const xform = template.mechanisms?.["sys-xform"], workflow = template.mechanisms?.lbpmTemplate;
  assert.ok(template.fdName?.startsWith("MK_TEST_") && template.fdCategory?.fdId === categoryId);
  assert.ok([1, 2].includes(template.fdStatus) && xform?.fdStatus === "official");
  assert.ok(officialForm.fdId === xform.fdVersionId && officialForm.fdEntityId === template.fdId &&
    officialForm.fdXForm?.fdId === template.fdId && officialForm.fdStatus === "official" && officialForm.fdTableName === template.fdTableName);
  assert.ok(workflow?.length === 1 && workflow[0].fdStatus === "published" && workflow[0].isDraft === false && workflow[0].fdContent);
  const plan = prepareChoiceOtherLayoutConfig({ config: JSON.parse(officialForm.fdConfig), priorDsl, dsl });
  const designBefore = JSON.parse(xform.fdConfig);
  const designAfter = prepareChoiceOtherLayoutConfig({ config: designBefore, priorDsl, dsl }).config;
  return {
    payload: { fdId: officialForm.fdId, fdConfig: JSON.stringify(plan.config), mechanisms: officialForm.mechanisms || {} },
    changes: plan.changes,
    verify(afterTemplate, afterForm) {
      try {
        const profiles = /^[a-f0-9]{32}$/i.test(officialForm.fdProfileId || "") && /^[a-f0-9]{32}$/i.test(afterForm.fdProfileId || "");
        const design = configWithoutViewAudit(JSON.parse(afterTemplate.mechanisms["sys-xform"].fdConfig));
        return same(protectedTemplate(template, profiles ? officialForm.fdProfileId : undefined), protectedTemplate(afterTemplate, profiles ? afterForm.fdProfileId : undefined)) &&
          same(protectedOfficial(officialForm, profiles), protectedOfficial(afterForm, profiles)) &&
          same(normalizedOfficialViewConfig(plan.config, JSON.parse(afterForm.fdConfig), officialForm, afterForm), configWithoutViewAudit(plan.config)) &&
          (same(design, configWithoutViewAudit(designBefore)) || same(design, configWithoutViewAudit(designAfter)));
      } catch { return false; }
    }
  };
}

/** Native content-addressed view profiles and initialization of the same view's audit fields. */
export function normalizedOfficialViewConfig(expected, actual, beforeForm, afterForm) {
  const next = configWithoutViewAudit(actual), original = JSON.parse(beforeForm.fdConfig);
  const md5 = value => createHash("md5").update(value).digest("hex");
  assert.equal(next.viewModel.length, expected.viewModel.length);
  for (let i = 0; i < expected.viewModel.length; i++) {
    const from = expected.viewModel[i], to = next.viewModel[i], old = original.viewModel[i];
    assert.equal(to.fdId, from.fdId);
    const changed = ["fdProfileId", "fdCreator", "fdCreateTime"].some(key => !same(from[key], to[key]));
    if (!changed) continue;
    assert.equal(to.fdId, old.fdId);
    assert.equal(to.fdFormVersionId, beforeForm.fdId);
    assert.equal(old.fdFormVersionId, beforeForm.fdId);
    assert.equal(to.fdXForm.fdId, beforeForm.fdXForm.fdId);
    assert.equal(old.fdXForm.fdId, beforeForm.fdXForm.fdId);
    if (!same(from.fdProfileId, to.fdProfileId)) {
      assert.equal(from.fdProfileId, old.fdProfileId);
      assert.equal(old.fdProfileId, md5(old.fdConfig));
      assert.equal(to.fdProfileId, md5(to.fdConfig));
      to.fdProfileId = from.fdProfileId;
    }
    if (!same(from.fdCreator, to.fdCreator)) {
      assert.ok(!Object.hasOwn(old, "fdCreator") && !Object.hasOwn(from, "fdCreator"));
      assert.ok(same(to.fdCreator, beforeForm.fdCreator) && same(to.fdCreator, afterForm.fdCreator));
      delete to.fdCreator;
    }
    if (!same(from.fdCreateTime, to.fdCreateTime)) {
      assert.ok(!Object.hasOwn(old, "fdCreateTime") && !Object.hasOwn(from, "fdCreateTime"));
      assert.ok(Number.isSafeInteger(to.fdCreateTime) && Number.isSafeInteger(beforeForm.fdCreateTime) &&
        Number.isSafeInteger(afterForm.fdAlterTime) && to.fdCreateTime >= beforeForm.fdCreateTime && to.fdCreateTime <= afterForm.fdAlterTime);
      delete to.fdCreateTime;
    }
  }
  return next;
}
