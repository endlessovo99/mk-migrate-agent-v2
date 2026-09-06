import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyEvidenceBackedPatches,
  collectSourceRefs
} from "../../src/agent-review/review-validation.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture = "tests/fixtures/source4/16cfa01c2b238241f6da8df46bd9cbb2";
const actionIds = [
  "fd_37c24b36b002dc.script.1.event.1",
  "fd_37c304733e52c8.script.1.event.1",
  "fd_37c304733e52c8.script.1.event.2"
];

describe("private non-project expense script closure", () => {
  it("proves named onChange field reads and accepts their complete assignments", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const actions = actionIds.map((id) => {
      const index = dslDraft.scripts.actions.findIndex((action) => action.id === id);
      assert.notEqual(index, -1, id);
      return { index, action: dslDraft.scripts.actions[index] };
    });

    assert.deepEqual(
      actions.map(({ action }) => action.branchProvenance?.status),
      ["proven", "proven", "proven"]
    );
    assert.deepEqual(
      actions.map(({ action }) => action.branchProvenance?.onChangeOperandMode),
      ["static-field-read", "static-field-read", "static-field-read"]
    );

    const functions = [expenseTypeFunction(), copiedAmountFunction(), copiedAmountFunction()];
    const patches = actions.flatMap(({ index, action }, actionOffset) => (
      actionPatches(index, action, functions[actionOffset])
    ));
    const reviewed = applyEvidenceBackedPatches(dslDraft, patches, {
      sourceRefs: collectSourceRefs(sourceDraft),
      sourceDraft
    });

    assert.equal(reviewed.ok, true, JSON.stringify(reviewed.diagnostics));
    assert.equal(checkDraft(reviewed.dslDraft).ok, true);
  });
});

function expenseTypeFunction() {
  return [
    "function onChange(value) {",
    "  const expenseType = MKXFORM.getValue('bxlx')",
    "  if (expenseType == 'clbx') { MKXFORM.setValue('fd_VKORG', '差旅报销') }",
    "  if (expenseType == 'jbchef') { MKXFORM.setValue('fd_VKORG', '市内交通') }",
    "  if (expenseType == 'jbcf') { MKXFORM.setValue('fd_VKORG', '加班餐费') }",
    "  if (expenseType == 'qtfy') { MKXFORM.setValue('fd_VKORG', '其他费用') }",
    "  if (expenseType == 'ywzd') { MKXFORM.setValue('fd_VKORG', '业务招待') }",
    "  if (expenseType == 'dqfy') { MKXFORM.setValue('fd_VKORG', '党群费用') }",
    "}"
  ].join("\n");
}

function copiedAmountFunction() {
  return [
    "function onChange(value) {",
    "  const expenseMode = MKXFORM.getValue('fd_37b043118c3a96')",
    "  if (expenseMode == '2') {",
    "    MKXFORM.setValue('fd_37b04352d61434', MKXFORM.getValue('fd_37b0427afd7746'))",
    "  } else if (expenseMode == '1') {",
    "    MKXFORM.setValue('fd_37b04352d61434', 0)",
    "  } else {",
    "    MKXFORM.setValue('fd_37b04352d61434', MKXFORM.getValue('fd_37b04352d61434'))",
    "  }",
    "}"
  ].join("\n");
}

function actionPatches(index, action, functionText) {
  const patch = (property, value) => ({
    op: "replace",
    path: `/scripts/actions/${index}/${property}`,
    value,
    sourceRefs: action.sourceRefs,
    evidence: ["The named source callback and its static field reads are preserved exactly."],
    confidence: 0.98,
    rationale: "Close the source-backed field assignments without changing their branches."
  });
  return [
    patch("function", functionText),
    patch("translationStatus", "mapped"),
    patch("functionMappings", [{
      source: "legacy named value-change callback",
      target: "MKXFORM.getValue + MKXFORM.setValue",
      basis: "semantic-translation",
      reviewRequired: false
    }]),
    patch("coverage", { status: "translated", nativeRules: [], residuals: [] })
  ];
}
