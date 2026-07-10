import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectTemplate, formAttr } from "../helpers/persistence.js";
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

  localCorpusIt("writes six target-fixture linkage rules and excludes detail-table review rules", () => {
    const dsl = draftSourceDraft(cleanSourceFile(targetFixture));
    const executable = dsl.formRules.linkage.filter((rule) => rule.translationStatus === "executable");
    const mergedJsx = executable.find((rule) => rule.meta.sourceRuleIds?.length === 4);
    const formRule = formAttr(projectTemplate(dsl)).formRule;
    const allRules = [...formRule.display, ...formRule.require];

    assert.equal(formRule.display.length, 12);
    assert.equal(formRule.require.length, 12);
    assert.deepEqual(
      [...new Set(allRules.map((rule) => rule.meta.sourceRuleId))].sort(),
      executable.map((rule) => rule.id).sort()
    );
    assert.deepEqual(
      [...new Set(allRules.flatMap((rule) => rule.result.map((result) => result.fieldName)))].sort(),
      [
        "fd_3da33437ef5bfc",
        "fd_3e24177a9d94b4",
        "fd_3f3165cdddb2cc",
        "fd_38e47377ddcd7e",
        "fd_38e4741c029f44",
        "fd_39f8f1b8f9111e"
      ].sort()
    );

    const mergedDisplayRules = formRule.display.filter((rule) => rule.meta.sourceRuleId === mergedJsx.id);
    const whenRule = mergedDisplayRules.find((rule) => rule.meta.branch === "when");
    const elseRule = mergedDisplayRules.find((rule) => rule.meta.branch === "else");
    assert.equal(whenRule.condition, "2");
    assert.equal(whenRule.choices.items.length, 4);
    assert.equal(whenRule.choices.items.every((item) => item.operate === "include"), true);
    assert.equal(elseRule.condition, "1");
    assert.equal(elseRule.choices.items.length, 4);
    assert.equal(elseRule.choices.items.every((item) => item.operate === "notInclude"), true);
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
