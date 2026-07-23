import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixturePath = "tests/fixtures/source/1670297c984b45009eb5b1e444d9957d";
const sourceDraft = cleanSourceFile(fixturePath);
const dslDraft = draftSourceDraft(sourceDraft);
const invoiceFixturePath = "tests/fixtures/source/18aac2e235a65c382f6fe264e1dba521";
const invoiceSourceDraft = cleanSourceFile(invoiceFixturePath);
const invoiceDslDraft = draftSourceDraft(invoiceSourceDraft);

describe("Agent Review non-native row-marker prompt", () => {
  it("uses the proven onLoad field condition and exact non-required row effects", () => {
    const { opportunity } = fixtureOpportunity("fd_3e502424ad4b9e.script.2.event.1");
    const fn = opportunity.suggestedPatchShape.function;

    assert.match(fn, /MKXFORM\.getValue\("fd_aqxyshift"\)/);
    assert.match(fn, /if \(normalizedValue\.indexOf\("A"\) >= 0\) \{/);
    assert.match(fn, /MKXFORM\.setFieldAttr\("aqxy_row", 5\)/);
    assert.match(fn, /MKXFORM\.setFieldAttr\("aqxy_row", 4\)/);
    assert.equal(count(fn, 'MKXFORM.setFieldAttr("aqxy_row", 6)'), 2);
    assert.doesNotMatch(fn, /MKXFORM\.setFieldAttr\("aqxy_row", 3\)/);
    assert.doesNotMatch(fn, /\/\* helper or trigger field id \*\//);
    assert.doesNotMatch(fn, /\?/);
  });

  it("combines exact helper assignments and row effects in explicit onChange branches", () => {
    const { opportunity } = fixtureOpportunity("fd_3da5a6abc177a2.script.1.event.2");
    const fn = opportunity.suggestedPatchShape.function;

    assert.match(fn, /if \(value\.indexOf\("D"\) >= 0\) \{/);
    assert.match(fn, /MKXFORM\.setValue\("fd_ypfwshift", "D"\)/);
    assert.match(fn, /MKXFORM\.setValue\("fd_ypfwshift", ""\)/);
    assert.match(fn, /MKXFORM\.setFieldAttr\("fd_jsx_row", 5\)/);
    assert.match(fn, /MKXFORM\.setFieldAttr\("fd_jsx_row", 3\)/);
    assert.match(fn, /MKXFORM\.setFieldAttr\("fd_jsx_row", 4\)/);
    assert.match(fn, /MKXFORM\.setFieldAttr\("fd_jsx_row", 6\)/);
    assert.doesNotMatch(fn, /MKXFORM\.(?:setValue|setFieldAttr)\([^\n]*\?/);
    assert.deepEqual(
      opportunity.suggestedPatchShape.functionMappings.map((mapping) => mapping.target),
      ["MKXFORM.setFieldAttr", "MKXFORM.setValue"]
    );
  });

  it("uses the same explicit assignment shape for every matching uncovered callback", () => {
    const cases = [
      ["fd_3da5a6abc177a2.script.1.event.2", "D", "fd_ypfwshift"],
      ["fd_39f8cbfaefc12c.script.1.event.2", "F", "fd_gjqjqtshift"],
      ["fd_39f8ebfc128778.script.1.event.2", "D", "fd_cbfwshift"],
      ["fd_3f3165d0ab5bd6.script.1.event.2", "D", "fd_glqxshift"]
    ];

    for (const [actionId, value, target] of cases) {
      const fn = fixtureOpportunity(actionId).opportunity.suggestedPatchShape.function;
      assert.equal(fn.includes(`if (value.indexOf(${JSON.stringify(value)}) >= 0) {`), true);
      assert.equal(fn.includes(`MKXFORM.setValue(${JSON.stringify(target)}, ${JSON.stringify(value)})`), true);
      assert.equal(fn.includes(`MKXFORM.setValue(${JSON.stringify(target)}, "")`), true);
      assert.doesNotMatch(fn, /MKXFORM\.(?:setValue|setFieldAttr)\([^\n]*\?/);
    }
  });

  it("emits direct row state for unconditional onLoad handlers", () => {
    for (const actionId of [
      "fd_3da5a6abc177a2.script.1.event.1",
      "fd_39f8cbfaefc12c.script.1.event.1",
      "fd_39f8ebfc128778.script.1.event.1",
      "fd_3f3165d0ab5bd6.script.1.event.1"
    ]) {
      const fn = fixtureOpportunity(actionId).opportunity.suggestedPatchShape.function;
      assert.equal(fn, [
        "function onLoad() {",
        '  MKXFORM.setFieldAttr("fd_jsx_row", 4)',
        '  MKXFORM.setFieldAttr("fd_jsx_row", 6)',
        "}"
      ].join("\n"));
      assert.doesNotMatch(fn, /MKXFORM\.getValue|\/\*|\?/);
    }
  });

  it("emits the exact three-way onLoad chain for non-fd helper fields", () => {
    const { opportunity } = opportunityFor(
      invoiceSourceDraft,
      invoiceDslDraft,
      "fd_3bd76c4765a0e4.script.2.event.1"
    );
    const fn = opportunity.suggestedPatchShape.function;

    assert.match(fn, /var normalizedValue = MKXFORM\.getValue\("wayTemp"\)/);
    assert.match(fn, /if \(normalizedValue == "11"\) \{/);
    assert.match(fn, /else if \(normalizedValue == "22"\) \{/);
    assert.equal(count(fn, 'MKXFORM.setFieldAttr("file_row", 4)'), 2);
    assert.equal(count(fn, 'MKXFORM.setFieldAttr("file_row", 5)'), 1);
    assert.equal(count(fn, 'MKXFORM.setFieldAttr("invoice_row4", 5)'), 1);
    assert.equal(count(fn, 'MKXFORM.setFieldAttr("invoice_row4", 4)'), 2);
    assert.doesNotMatch(fn, /invoice_row1(?:0|1|11|2|21|22|3|31)/);
    assert.doesNotMatch(fn, /Array\.isArray|\?|forEach|\/\*/);
  });
});

function fixtureOpportunity(actionId) {
  return opportunityFor(sourceDraft, dslDraft, actionId);
}

function opportunityFor(source, dsl, actionId) {
  const actionIndex = dsl.scripts.actions.findIndex((action) => action.id === actionId);
  assert.notEqual(actionIndex, -1);
  const prompt = buildAgentReviewPrompt(source, dsl, {
    compact: true,
    reviewScope: {
      actionIndexes: [actionIndex],
      actionIds: [actionId],
      includeFormTargets: true
    }
  });
  const action = prompt.context.dslDraft.scripts.actions[0];
  const opportunity = action.reviewOpportunities.find((item) => (
    item.kind === "row_marker_visibility_candidate"
  ));
  assert.ok(opportunity?.suggestedPatchShape);
  return { action, opportunity };
}

function count(text, needle) {
  return text.split(needle).length - 1;
}
