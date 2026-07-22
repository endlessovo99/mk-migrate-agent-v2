import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectTemplate, formAttr, xformConfig } from "../helpers/persistence.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { localCorpusIt } from "../helpers/local-corpus.js";
import { sampleDraftDsl } from "../helpers/sample-dsl.js";

const targetFixture = "tests/fixtures/source/1670297c984b45009eb5b1e444d9957d";

describe("native form-rule materialization", () => {
  it("materializes only executable linkage rules", () => {
    const dsl = sampleDraftDsl({
      workflow: undefined,
      formRules: {
        linkage: [
          sampleRule("rule.executable", "executable"),
          sampleRule("rule.needs-review", "needs_review")
        ],
        validations: [],
        impliedRequired: [],
        review: {}
      }
    });
    const formRule = formAttr(projectTemplate(dsl)).formRule;

    assert.equal(formRule.display.length, 2);
    assert.equal(formRule.require.length, 2);
    assert.deepEqual(
      [...new Set([...formRule.display, ...formRule.require].map((rule) => rule.meta.sourceRuleId))],
      ["rule.executable"]
    );
  });

  localCorpusIt("writes only non-conflicting target-fixture linkage rules with formula gates", () => {
    const dsl = draftSourceDraft(cleanSourceFile(targetFixture));
    const executable = dsl.formRules.linkage.filter((rule) => rule.translationStatus === "executable");
    const template = projectTemplate(dsl);
    const formRule = formAttr(template).formRule;
    const allRules = [...formRule.display, ...formRule.require];
    const detailTableNames = xformConfig(template).dataModel
      .filter((model) => model.fdType === "detail")
      .map((model) => model.fdTableName)
      .sort();

    assert.equal(executable.length, 8);
    assert.equal(formRule.display.length, 16);
    assert.equal(formRule.require.length, 16);
    assert.deepEqual(
      [...new Set(allRules.map((rule) => rule.meta.sourceRuleId))].sort(),
      executable.map((rule) => rule.id).sort()
    );
    const detailDisplayResults = formRule.display
      .flatMap((rule) => rule.result)
      .filter((result) => Array.isArray(result.fieldName));
    assert.equal(detailDisplayResults.length, 6);
    assert.equal(detailDisplayResults.every((result) => result.tableType === "detail" && result.fieldName[0] === "all"), true);
    assert.deepEqual(
      [...new Set(detailDisplayResults.map((result) => result.type))].sort(),
      detailTableNames
    );

    const detailRequireTargets = formRule.require
      .flatMap((rule) => rule.result)
      .map((result) => result.fieldName)
      .filter((fieldName) => /^fd_3e501d8/.test(fieldName));
    assert.equal(detailRequireTargets.length, 6);
    assert.deepEqual(
      [...new Set(detailRequireTargets)].sort(),
      ["fd_3e501d840bbb6e", "fd_3e501d85c8795a", "fd_3e501d87ae5c80"].sort()
    );

    assert.equal(allRules.every((rule) => rule.condition === "1"), true);
    assert.equal(allRules.every((rule) => rule.choices.items.length === 1), true);
    assert.equal(allRules.every((rule) => rule.choices.items[0].condNodeType === "formula"), true);
    assert.equal(allRules.every((rule) => /MKXFORM\.viewStatus/.test(rule.choices.items[0].value.script)), true);
    assert.equal(
      allRules.some((rule) => rule.result.some((result) => result.fieldName === "fd_jsx_row")),
      false
    );
  });
});

function sampleRule(id, translationStatus) {
  return {
    id,
    trigger: "change",
    source: "fd_subject",
    logic: "and",
    when: [{ field: "fd_subject", op: "eq", value: "A" }],
    effects: [
      { type: "visible", target: "fd_amount", value: true },
      { type: "required", target: "fd_amount", value: true }
    ],
    else: [
      { type: "visible", target: "fd_amount", value: false },
      { type: "required", target: "fd_amount", value: false }
    ],
    translationStatus
  };
}
