import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { observeNativeTemplate } from "../../src/executor/persistence/observer.js";
import { projectTemplate } from "../helpers/persistence.js";

const fixture = "tests/fixtures/source4/176ef18822991388a2fe04d4cf1b1624";
const sourceField = "fd_3936ce781f71a4";
const peopleTable = "fd_3936ced20ba788";
const permissionContainer = "fd_3937aca828a964";

describe("project resource container visibility route", () => {
  it("projects the jQuery container switch into complete native visibility rules", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const permissionRow = dsl.form.layout.mkTree.find((row) => row.id === "layout.row-5");

    assert.equal(permissionRow?.sourceMarkers?.includes(permissionContainer), true);
    assert.equal(
      dsl.form.fields.some((field) => field.id === permissionContainer),
      false,
      "the standard-table DOM id is a layout marker, not an invented field"
    );

    const rules = dsl.formRules.linkage.filter((rule) => rule.source === sourceField);
    assert.equal(rules.length, 2);
    assert.deepEqual(rules.map((rule) => rule.trigger), ["change", "change"]);
    for (const { value, target } of [
      { value: "rlzy", target: peopleTable },
      { value: "qxfwq", target: permissionContainer }
    ]) {
      const targetRules = rules.filter((rule) => rule.effects[0]?.target === target);
      assert.equal(targetRules.length, 1);
      assert.deepEqual(targetRules.map((rule) => rule.trigger), ["change"]);
      for (const rule of targetRules) {
        assert.deepEqual(rule.when, [{ field: sourceField, op: "eq", value }]);
        assert.deepEqual(rule.effects, [{ type: "visible", target, value: true }]);
        assert.deepEqual(rule.else, [{ type: "visible", target, value: false }]);
      }
    }

    const actions = dsl.scripts.actions.filter((action) => action.controlId === sourceField);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].event, "onChange");
    assert.equal(actions[0].translationStatus, "omitted");
    assert.equal(actions[0].coverage.status, "covered");
    assert.deepEqual(actions[0].coverage.nativeRules.sort(), rules.map((rule) => rule.id).sort());

    const nativeRules = observeNativeTemplate(projectTemplate(dsl)).rules.value.rules;
    const permissionFieldIds = [
      "fd_3937ae28234e62",
      "fd_3937adc71a6268",
      "fd_3937ae2ecaa4c8",
      "fd_3937adcda88ab2",
      "fd_3937ae31495a64",
      "fd_3937add8783650",
      "fd_3937ae3444a028",
      "fd_3937ade104e560",
      "fd_3937ae36675e04",
      "fd_3937ad83d01188",
      "fd_3937ae38baede8",
      "fd_3937ad85714f96"
    ];
    const visibleEffects = nativeRules
      .flatMap((rule) => rule.effects || [])
      .filter((effect) => effect.visible === true)
      .map((effect) => effect.target);
    for (const fieldId of permissionFieldIds) {
      assert.equal(visibleEffects.includes(fieldId), true, `${fieldId} must follow the permission container`);
    }
  });
});
