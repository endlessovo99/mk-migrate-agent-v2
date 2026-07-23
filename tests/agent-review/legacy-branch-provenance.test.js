import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildScriptBranchProvenance } from "../../src/dsl/script-branch-provenance.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { namedValueChangeAssignmentCandidates } from "../../src/translator/named-value-change-assignment.js";

const fixturePath = "tests/fixtures/source/1670297c984b45009eb5b1e444d9957d";

describe("legacy branch provenance", () => {
  it("traces a stable legacy field-element alias through its value member onLoad", () => {
    const source = [
      "Com_AddEventListener(window, 'load', function(){",
      "  var element = GetXFormFieldById('fd_helper')[0]",
      "  if (element.value.indexOf('A') >= 0) showRow()",
      "})"
    ].join("\n");
    const result = buildScriptBranchProvenance({
      event: "onLoad",
      source,
      eventFunctionStart: source.indexOf("function")
    });

    assert.equal(result.status, "proven");
    assert.deepEqual(result.conditions, [{
      kind: "contains",
      value: "A",
      origin: "field:fd_helper",
      transforms: [],
      predicate: "indexOf"
    }]);
  });

  it("compiles exact named same-control assignment callbacks and proves every remaining branch", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const deterministic = dslDraft.scripts.actions.filter((action) => (
      action.deterministicBranchProof?.basis === "deterministic-calculation-assignment"
    ));
    const unproven = dslDraft.scripts.actions
      .map((action, index) => ({ index, action }))
      .filter(({ action }) => action.branchProvenance?.status === "unproven")
      .map(({ index, action }) => ({ index, reason: action.branchProvenance.reason }));

    assert.equal(deterministic.length, 2);
    assert.deepEqual(deterministic.map((action) => action.controlId), [
      "fd_3268bfe94b435c",
      "fd_3268bfe94b435c"
    ]);
    assert.equal(
      deterministic.some((action) => action.function.includes('MKXFORM.setValue("fd_shift2", "任务类")')),
      true
    );
    assert.equal(
      deterministic.some((action) => action.function.includes('MKXFORM.setValue("fd_shift", "部件可靠性测试")')),
      true
    );
    assert.deepEqual(unproven, []);
  });

  it("rejects named callbacks with any unrecognized side effect", () => {
    const javascript = [
      "function changeValue(){",
      "  var source = GetXFormFieldValueById('fd_source')",
      "  var target = GetXFormFieldById('fd_target')",
      "  audit(source)",
      "  if (source == 'A') { target[0].value = 'mapped' }",
      "}",
      "AttachXFormValueChangeEventById('fd_source', changeValue)"
    ].join("\n");
    const candidates = namedValueChangeAssignmentCandidates(
      { id: "script.1", sourceRef: "fixture#script.1", javascript },
      { fields: [{ id: "fd_source" }, { id: "fd_target" }] }
    );

    assert.deepEqual(candidates, []);
  });
});
