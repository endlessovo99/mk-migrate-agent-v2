import assert from "node:assert/strict";
import { sha256Digest } from "../agent-review/digest.js";

// Pure existing-target plan. Its caller must independently verify that the
// reviewed source/DSL and their native projections are trusted for the target.
// It never authorizes, sends, or retries a NewOA request.
export function prepareStaticDescriptionVisibility({ config, previous, reviewed, initialization, anchorId, tableName, projectionTableName }) {
  assert.ok(config && previous && reviewed && initialization?.version === 1 && Array.isArray(initialization.entries));
  assert.ok(/^[A-Za-z_][A-Za-z0-9_]*$/.test(anchorId) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName));
  assert.ok(typeof projectionTableName === "string" && projectionTableName.length > 0);
  const entries = initialization.entries;
  assert.ok(entries.length && new Set(entries.map(e => e.ruleId)).size === entries.length &&
    new Set(entries.map(e => e.changeActionId)).size === entries.length, "initialization entries must be unique");
  const next = structuredClone(config), attr = JSON.parse(next.attribute?.formAttr || "{}");
  const oldProjection = remap(previous, projectionTableName, tableName);
  const fixedProjection = remap(reviewed, projectionTableName, tableName);
  assert.deepEqual(attr.formRule?.display, oldProjection.formRule?.display, "current display rules differ from the source projection");
  assert.deepEqual(attr.controlAction, oldProjection.controlAction, "current actions differ from the source projection");
  assert.equal(JSON.stringify(attr.controlAction).includes(anchorId), false, "current actions address the static anchor");
  assert.equal(JSON.stringify(attr.formRule).includes(anchorId), false, "current rules address the static anchor");
  const models = (next.dataModel || []).filter(model => model.fdType === "main" && model.fdTableName === tableName);
  assert.equal(models.length, 1);
  const matches = (next.dataModel || []).flatMap(model => (model.fdFields || []).filter(field => field.fdName === anchorId));
  assert.equal(matches.length, 1);
  const field = matches[0];
  assert.ok(field.fdType === "desc" && field.fdIsStored === false && field.fdDisplay === true, "anchor must be a displayed, nonstored description");
  const node = JSON.parse(field.fdAttribute || "{}").config;
  assert.ok(node?.kind === "control" && node.type === "desc" && node.controlProps?.name === anchorId &&
    typeof node.key === "string" && node.key.startsWith("@elem/xform-description~") &&
    typeof node.controlProps.content === "string" && node.controlProps.content.length > 0 &&
    node.controlProps.desktop?.type === "@elem/xform-description" && node.controlProps.mobile?.type === "@elem/xform-m-description",
  "anchor native control is not a static description");
  assert.ok(!Object.keys(node.controlProps).some(key => /^(?:on|script|formula|event)/i.test(key)), "anchor has dynamic control behavior");
  for (const view of next.viewModel || []) {
    const render = JSON.parse(view.fdConfig || "{}").view?.render;
    for (const platform of ["desktop", "mobile"]) {
      const found = []; walk(render?.[platform], item => {
        if (item.key === anchorId && Object.keys(item).every(key => key === "key" || key.startsWith("migration"))) found.push(item);
      });
      assert.equal(found.length, 1, `anchor is not unique in ${platform} view`);
    }
  }
  assert.ok(Array.isArray(next.viewModel) && next.viewModel.length > 0);
  const beforeRules = attr.formRule.display, fixedRules = fixedProjection.formRule?.display;
  assert.equal(beforeRules.length, entries.length * 2, "unexpected current display rule scope");
  assert.equal(fixedRules?.length, entries.length, "unexpected reviewed display rule scope");
  const replacements = [];
  for (const entry of entries) {
    const prefix = `mk-migrate-agent-v2:${entry.ruleId}`;
    const yes = unique(beforeRules.filter(rule => rule.ruleName === `${prefix}:when:display`));
    const no = unique(beforeRules.filter(rule => rule.ruleName === `${prefix}:else:display`));
    const fixed = unique(fixedRules.filter(rule => rule.ruleName === `mk-migrate-agent-v2:initial.${entry.ruleId}:when:display`));
    assert.ok(yes.active === true && no.active === true && fixed.active === true && fixed.condition === "1");
    assert.equal(fixed.choices?.items?.length, 1);
    const condition = fixed.choices.items[0];
    assert.ok(condition.condNodeType === "condition" && condition.fieldName === initialization.anchorId && condition.operate === "empty" &&
      condition.tableType === "main" && condition.type === "main", "reviewed initialization rule has an unexpected condition");
    assert.ok(Array.isArray(no.result) && no.result.length && no.result.every(result => result.displayFlag === "hide") &&
      same(semanticResults(no.result), semanticResults(fixed.result)), "reviewed initialization differs from the original hidden result");
    const rule = structuredClone(fixed), empty = structuredClone(condition), notEmpty = structuredClone(condition);
    for (const item of [empty, notEmpty]) { item.fieldName = anchorId; item.fieldKey = anchorId; item.label = field.fdLabel; }
    notEmpty.operate = "notEmpty";
    for (const key of ["tableFieldID", "fieldID", "OperaterID", "formulaID", "valueTypeID", "tableTypeID"]) {
      assert.equal(typeof notEmpty[key], "string"); notEmpty[key] += "-notempty";
    }
    rule.condition = "2"; rule.choices.items = [empty, notEmpty]; replacements.push(rule);
  }
  assert.equal(new Set(replacements.map(rule => rule.id)).size, entries.length, "initial rule identities are ambiguous");
  attr.formRule.display = replacements;
  const currentActions = actionMap(attr.controlAction), oldActions = actionMap(oldProjection.controlAction), fixedActions = actionMap(fixedProjection.controlAction);
  assert.deepEqual([...currentActions.keys()].sort(), [...fixedActions.keys()].sort(), "reviewed action set changed");
  let changedActions = 0;
  for (const id of currentActions.keys()) {
    const current = currentActions.get(id), old = oldActions.get(id), fixed = fixedActions.get(id);
    assert.deepEqual(current, old);
    const currentRest = { ...current }, fixedRest = { ...fixed }; delete currentRest.function; delete fixedRest.function;
    assert.deepEqual(currentRest, fixedRest, "reviewed action metadata changed");
    if (current.function !== fixed.function) {
      assert.ok(entries.some(entry => entry.changeActionId === id), "unapproved action changed");
      assert.equal(current.function.split('value.indexOf(').length, 2, "null adaptation must apply to exactly one expression");
      assert.equal(current.function.replace('value.indexOf(', '(value === null ? "" : value).indexOf('), fixed.function,
        "reviewed action changes more than null-to-empty adaptation");
      current.function = fixed.function; changedActions++;
    }
  }
  assert.deepEqual(attr.controlAction, fixedProjection.controlAction, "action projection differs after the bounded changes");
  next.attribute.formAttr = JSON.stringify(attr);
  return { config: next, changed: true, changes: { anchorId, previousRules: beforeRules.length, initializationRules: replacements.length, changedActions },
    evidence: { oldProjectionDigest: sha256Digest(oldProjection), fixedProjectionDigest: sha256Digest(fixedProjection) } };
}

function semanticResults(results) {
  assert.ok(Array.isArray(results));
  return results.map(({ fieldID, actionID, tID, tableTypeID, ...result }) => result);
}
function unique(items) { assert.equal(items.length, 1, "native rule identity is ambiguous"); return items[0]; }
function same(a, b) { return sha256Digest(a) === sha256Digest(b); }
function remap(value, from, to) { return JSON.parse(JSON.stringify(value).replaceAll(from, to)); }
function walk(node, visit) { if (!node || typeof node !== "object") return; if (!Array.isArray(node)) visit(node); for (const value of Object.values(node)) if (value && typeof value === "object") walk(value, visit); }
function actionMap(node) {
  const result = new Map();
  walk(node, item => {
    if (typeof item.function !== "string") return;
    assert.ok(typeof item.id === "string" && !result.has(item.id), "native action identity is ambiguous");
    result.set(item.id, item);
  });
  return result;
}
