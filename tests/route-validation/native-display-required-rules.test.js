import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { formAttr, projectTemplate } from "../helpers/persistence.js";

const fixture = "tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac";

describe("18bd native display/required route", () => {
  it("persists the four edit-only A/B/C/D branches as eight formula-gated display and required rules", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const linkage = dsl.formRules.linkage.filter((rule) => rule.translationStatus === "executable");

    assert.equal(linkage.length, 4);
    assert.equal(linkage.every((rule) => rule.source === "fd_3c66895473ff5c"), true);
    assert.equal(linkage.every((rule) => rule.meta.conditionSource === "event:value"), true);
    assert.equal(linkage.every((rule) => rule.meta.nativeProjection?.kind === "view-status-formula"), true);
    const onChange = dsl.scripts.actions.find((action) => action.event === "onChange");
    assert.equal(onChange.id, "fd_3c6a7b6050c71a.script.1.event.2");
    assert.equal(
      onChange.sourceActionKey,
      "source.form.jsp.fd_3c6a7b6050c71a.script.1#onChange@2045"
    );
    assert.equal(linkage.every((rule) => rule.meta.sourceActionKey === onChange.sourceActionKey), true);
    assert.deepEqual(onChange.coverage.nativeRules, linkage.map((rule) => rule.id));

    const formRule = formAttr(projectTemplate(dsl)).formRule;
    assert.equal(formRule.display.length, 8);
    assert.equal(formRule.require.length, 8);
    for (const rule of [...formRule.display, ...formRule.require]) {
      assert.equal(rule.choices.items.length, 1);
      const condition = rule.choices.items[0];
      assert.equal(condition.condNodeType, "formula");
      assert.deepEqual(condition.value.varIds, ["fd_3c66895473ff5c"]);
      assert.match(condition.value.script, /^\(MKXFORM\.viewStatus/);
      assert.match(condition.value.script, /\$\{data\.biz\.fd_3c66895473ff5c\}/);
    }
  });
});
