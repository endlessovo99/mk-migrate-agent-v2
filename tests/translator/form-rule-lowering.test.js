import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sourceFormRulesFromLegacyScripts } from "../../src/translator/sysform-form-rules.js";
import { localCorpusIt } from "../helpers/local-corpus.js";

const targetFixture = "tests/fixtures/source/1670297c984b45009eb5b1e444d9957d";

describe("legacy JSP native form-rule lowering", () => {
  it("preserves edit-gate evidence while translating regex tests to equality conditions", () => {
    const formRules = sourceFormRulesFromLegacyScripts({
      sources: [
        sourceWithCondition("single", "/[O]/.test(value)", "glqx_row", "xform:editShow"),
        sourceWithCondition("multi", "/[ADEFGIMN]/.test(value)", "gjqjqt_row", "xform:editShow"),
        sourceWithCondition("view", "value.indexOf(\"D\") >= 0", "fd_jsx_row", "xform:viewShow")
      ]
    });

    assert.equal(formRules.linkage.length, 2);
    const single = formRules.linkage.find((rule) => rule.meta.sourceJsp === "source.form.jsp.single");
    const multi = formRules.linkage.find((rule) => rule.meta.sourceJsp === "source.form.jsp.multi");

    assert.equal(single.logic, "and");
    assert.deepEqual(single.when, [{ field: "fd_trigger", op: "eq", value: "O" }]);
    assert.deepEqual(single.meta, {
      sourceJsp: "source.form.jsp.single",
      displayGate: "xform:editShow",
      runWhen: { viewStatusIn: ["add", "edit"] }
    });

    assert.equal(multi.logic, "or");
    assert.deepEqual(multi.when, ["A", "D", "E", "F", "G", "I", "M", "N"].map((value) => ({
      field: "fd_trigger",
      op: "eq",
      value
    })));
    assert.equal(formRules.linkage.some((rule) => rule.meta.sourceJsp === "source.form.jsp.view"), false);
  });

  localCorpusIt("lowers the target fixture to nine executable rules including detail-table container rows", () => {
    const sourceDraft = cleanSourceFile(targetFixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const sourceRules = sourceDraft.formRules.linkage;
    const executable = dslDraft.formRules.linkage.filter((rule) => rule.translationStatus === "executable");
    const excludedRules = dslDraft.formRules.review.excludedRules || [];

    assert.equal(sourceRules.length, 12);
    assert.equal(executable.length, 9);
    assert.equal(excludedRules.length, 0);
    assert.equal(dslDraft.formRules.linkage.length, 9);
    assert.equal(dslDraft.scripts.actions.length, 35);
    assert.equal(sourceRules.every((rule) => rule.meta.displayGate === "xform:editShow"), true);
    assert.equal(sourceRules.every((rule) => rule.meta.runWhen?.viewStatusIn.join(",") === "add,edit"), true);

    const detailRules = executable.filter((rule) =>
      (rule.effects || []).some((effect) => ["aqxy_row", "aqxy2_row", "aqxy3_row"].includes(effect.target))
    );
    assert.equal(detailRules.length, 3);
    assert.deepEqual(
      [...new Set(detailRules.flatMap((rule) => rule.effects.map((effect) => effect.target)))].sort(),
      ["aqxy2_row", "aqxy3_row", "aqxy_row"].sort()
    );

    const mergedJsx = executable.find((rule) => rule.meta.sourceRuleIds?.length === 4);
    assert.equal(mergedJsx.logic, "or");
    assert.equal(mergedJsx.when.length, 4);
    assert.equal(mergedJsx.meta.sourceRuleIds.length, 4);
    assert.equal(mergedJsx.meta.sourceJsps.length, 4);
    assert.deepEqual(dslDraft.formRules.review.mergedRules, [{
      ruleId: mergedJsx.id,
      sourceRuleIds: mergedJsx.meta.sourceRuleIds
    }]);

    assert.deepEqual(
      [...new Set(executable
        .filter((rule) => rule !== mergedJsx && !detailRules.includes(rule))
        .flatMap((rule) => rule.effects.map((effect) => effect.target)))].sort(),
      ["cbfw_row", "gjqjqt_row", "glqx_row", "qtfw_row", "ypfw_row"].sort()
    );

    const detailAction = actionFor(dslDraft, "source.form.jsp.fd_3e502424ad4b9e.script.1", "fd_3268bfe94b435c");
    assert.equal(detailAction.coverage.status, "partial");
    assert.equal(detailAction.coverage.nativeRules.length >= 1, true);
    assert.equal(detailAction.coverage.residuals.some((item) => item.code === "script.residual.form_rule_needs_review"), false);

    const serviceAction = actionFor(dslDraft, "source.form.jsp.fd_3e2435e961a482.script.1", "fd_38e47090921a54");
    assert.equal(serviceAction.coverage.status, "partial");
    assert.equal(serviceAction.coverage.nativeRules.length, 1);
    assert.deepEqual(serviceAction.runWhen, { viewStatusIn: ["add", "edit"] });

    const mergedActions = [
      ["source.form.jsp.fd_3da5a6abc177a2.script.1", "fd_3da33437ef5bfc"],
      ["source.form.jsp.fd_39f8cbfaefc12c.script.1", "fd_38e47377ddcd7e"],
      ["source.form.jsp.fd_39f8ebfc128778.script.1", "fd_38e4741c029f44"],
      ["source.form.jsp.fd_3f3165d0ab5bd6.script.1", "fd_3f3165cdddb2cc"]
    ].map(([sourceRef, controlId]) => actionFor(dslDraft, sourceRef, controlId));
    assert.equal(mergedActions.every((action) => action.coverage.status === "partial"), true);
    assert.equal(mergedActions.every((action) => JSON.stringify(action.coverage.nativeRules) === JSON.stringify([mergedJsx.id])), true);
    assert.equal(mergedActions.every((action) => action.runWhen?.viewStatusIn.join(",") === "add,edit"), true);
  });
});

function sourceWithCondition(id, condition, target, displayGate) {
  return {
    id,
    sourceRef: `source.form.jsp.${id}`,
    displayGate,
    javascript: `
      AttachXFormValueChangeEventById("fd_trigger", function(value) {
        if (${condition}) {
          common_dom_row_set_show_required_reset("${target}", true, true, false);
        } else {
          common_dom_row_set_show_required_reset("${target}", false, false, false);
        }
      });
    `
  };
}

function actionFor(dslDraft, sourceRef, controlId) {
  return dslDraft.scripts.actions.find((action) =>
    action.sourceRefs.includes(sourceRef) && action.controlId === controlId
  );
}
