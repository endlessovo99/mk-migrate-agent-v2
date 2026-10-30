import assert from "node:assert/strict";
import { sha256Digest } from "../agent-review/digest.js";
import { choiceOtherRevealBindings } from "../dsl/choice-other-reveal.js";
import { usesAdaptiveLayout } from "../dsl/layout-sizing.js";
import { effectiveCellFlow } from "./persistence/adaptive-layout.js";
import { buildChoiceOtherGroup, choiceOtherFlowGroups, observeChoiceOtherGroup } from "./persistence/choice-other-layout.js";
import { withChoiceOtherSelectReveal } from "./persistence/choice-other-select-reveal.js";
import { buildGlobalDispatcher } from "./persistence/form-writer.js";
import { markedDispatcherActionFunction } from "./persistence/script-dispatcher-contract.js";

const same = (left, right) => sha256Digest(left ?? null) === sha256Digest(right ?? null);
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...(node.children || []).flatMap(nodes)];

/** Pure preview. This function has no client, credentials, or authority to write. */
export function prepareChoiceOtherRevealConfig({ config, form, tableName, pairs }) {
  const bindings = choiceOtherRevealBindings(form);
  assert.ok(bindings.length && same(bindings, pairs), "approved Other field scope must match the complete source-derived bindings");
  const sourceFields = form.fields || [];
  const models = (config.dataModel || []).filter(model => model.fdType === "main" && model.fdTableName === tableName);
  assert.equal(models.length, 1, "native main model must match the existing table");
  const nativeFields = models[0].fdFields || [];
  for (const binding of bindings) {
    for (const id of [binding.choiceId, binding.triggerId, binding.textId]) {
      const fields = nativeFields.filter(field => field.fdName === id && field.fdDisplay === true && !field.fdIsSystem);
      assert.equal(fields.length, 1, `persisted field identity is not unique and visible: ${id}`);
      assert.ok(fields[0].fdIsStored === true && fields[0].fdDataType === "varchar", `independent string storage is not verified: ${id}`);
      const control = JSON.parse(fields[0].fdAttribute).config;
      const source = sourceFields.find(field => field.id === id);
      assert.ok(source && control.controlProps?.name === id, `persisted field binding changed: ${id}`);
      if (id === binding.textId) assert.equal(control.type, "@elem/xform-input", "Other text must remain an independent native input");
      else {
        assert.equal(control.type, `@elem/${source.componentId}`, "choice component changed");
        const original = (source.props?.options || []).map(({ label, value }) => ({ label, value }));
        const current = (control.controlProps.options || []).map(({ label, value }) => ({ label, value }));
        assert.deepEqual(current, original, "persisted choice options changed");
        if (id === binding.triggerId)
          assert.equal(current.filter(option => option.value === binding.optionValue).length, 1, "Other option binding changed");
      }
    }
  }
  const groups = [];
  const visit = node => {
    if (!node || typeof node !== "object") return;
    const flow = effectiveCellFlow(node, usesAdaptiveLayout(form));
    if (flow) groups.push(...choiceOtherFlowGroups(flow, sourceFields).filter(group => group.revealOnSelection));
    for (const child of node.children || []) visit(child);
  };
  for (const row of form.layout?.mkTree || []) visit(row);
  assert.equal(groups.length, bindings.length, "source Other groups are incomplete");
  const next = structuredClone(config), changes = [];
  assert.ok(Array.isArray(next.viewModel) && next.viewModel.length, "native view is missing");
  for (const [viewIndex, model] of next.viewModel.entries()) {
    const view = JSON.parse(model.fdConfig);
    for (const scene of ["desktop", "mobile"]) for (const group of groups) {
      assert.ok(Array.isArray(view.view?.render?.[scene]), `native ${scene} view is missing`);
      const all = view.view.render[scene].flatMap(nodes);
      const observed = all.flatMap(node => {
        const result = observeChoiceOtherGroup(node);
        return result && !result.invalid && same(result.group.referenceIds, group.referenceIds) ? [{ node, result }] : [];
      });
      assert.ok(observed.length <= 1, "Other group is ambiguous");
      if (observed.length) {
        const { node, result } = observed[0];
        const expectedGroup = { referenceIds: group.referenceIds, mode: group.mode, width: group.width, revealOnSelection: true };
        if (same(result.group, expectedGroup)) continue;
        assert.deepEqual(result.group, { referenceIds: group.referenceIds, mode: group.mode, width: group.width }, "existing Other group changed");
        const parents = all.filter(parent => parent.children?.includes(node));
        assert.equal(parents.length, 1, "existing Other group parent is ambiguous");
        const items = structuredClone(result.items);
        for (const item of items) {
          const classes = (item.controlProps.className || "").split(/\s+/).filter(value => value && !/^mk-choice-other-(?:choice|note)$/.test(value));
          assert.ok(classes.every(value => value === "mk-adaptive-main-field"), "existing Other wrapper class changed");
          if (classes.length) item.controlProps.className = classes.join(" "); else delete item.controlProps.className;
        }
        parents[0].children[parents[0].children.indexOf(node)] = buildChoiceOtherGroup(group, items);
      } else {
        assert.equal(group.mode, "select", "existing checkbox Other group is missing");
        const wrappers = group.referenceIds.map(id => all.filter(node => node.type === "div" && node.kind === "container" &&
          node.children?.length === 1 && node.children[0].key === id));
        assert.ok(wrappers.every(value => value.length === 1), "native Other wrappers are missing or ambiguous");
        const items = wrappers.map(value => value[0]);
        const parents = all.filter(parent => items.every(item => parent.children?.includes(item)));
        assert.equal(parents.length, 1, "Other wrappers must share one parent");
        const parent = parents[0], index = parent.children.indexOf(items[0]);
        assert.equal(parent.children[index + 1], items[1], "Other wrappers must remain adjacent and ordered");
        assert.deepEqual(parent.controlProps.style, { display: "flex", flexWrap: "wrap", alignItems: "center", minWidth: 0 });
        assert.ok(items.every(item => [undefined, "mk-adaptive-main-field"].includes(item.controlProps.className)));
        parent.children.splice(index, 2, buildChoiceOtherGroup(group, structuredClone(items)));
      }
      changes.push({ viewIndex, scene, triggerId: group.referenceIds[0], textId: group.referenceIds[1], mode: group.mode });
    }
    model.fdConfig = JSON.stringify(view);
  }
  const generated = withChoiceOtherSelectReveal({ actions: [] }, form, tableName).actions;
  if (generated.length) {
    assert.equal(generated.length, 1);
    const attr = JSON.parse(next.attribute.formAttr), global = attr.controlAction?.global;
    assert.ok(global && typeof global === "object", "native global actions are unavailable");
    const current = global.onLoad || [];
    assert.ok(Array.isArray(current) && current.length <= 1, "native onLoad dispatcher is ambiguous");
    let actions = [];
    if (current.length) {
      const dispatcher = current[0];
      assert.ok(Array.isArray(dispatcher.migrationActions) && dispatcher.migrationActions.length, "native onLoad is not a guarded dispatcher");
      actions = dispatcher.migrationActions.map(item => ({ ...item,
        function: markedDispatcherActionFunction(dispatcher.function, item.name).replace(/\n  /g, "\n") }));
      assert.ok(actions.every(item => item.function), "native onLoad action is missing");
      assert.deepEqual(buildGlobalDispatcher("onLoad", actions), dispatcher, "native onLoad dispatcher was changed");
    }
    const existing = actions.filter(item => item.id === generated[0].id);
    assert.ok(existing.length <= 1, "Other display action is ambiguous");
    const desired = buildGlobalDispatcher("onLoad", existing.length ? [...actions.filter(item => item !== existing[0]), generated[0]] : [...actions, generated[0]]);
    if (existing.length) assert.deepEqual(desired, current[0], "existing Other display action changed");
    else global.onLoad = [desired];
    next.attribute.formAttr = JSON.stringify(attr);
  }
  const protectedConfig = structuredClone(next);
  protectedConfig.viewModel = structuredClone(config.viewModel);
  protectedConfig.attribute.formAttr = config.attribute.formAttr;
  assert.deepEqual(protectedConfig, config, "native configuration outside Other presentation changed");
  return { config: next, changes, changed: !same(next, config), pairs: bindings };
}
