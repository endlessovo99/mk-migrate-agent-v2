import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

describe("agent-review hidden field and view gate context", () => {
  it("exposes data-only field evidence and immutable runWhen without allowing either to be patched", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/route-hidden-data-field");
    const dslDraft = draftSourceDraft(sourceDraft);
    const prompt = buildAgentReviewPrompt(sourceDraft, dslDraft);
    const sourceDataField = prompt.context.sourceDraft.form.dataFields.find((field) => field.id === "fd_shift");
    const dslDataField = prompt.context.dslDraft.form.fields.find((field) => field.id === "fd_shift");
    const editSource = prompt.context.sourceDraft.scripts.sources.find((source) => source.displayGate === "xform:editShow");
    const viewAction = prompt.context.dslDraft.scripts.actions.find((action) =>
      action.runWhen?.viewStatusIn?.[0] === "view"
    );

    assert.equal(sourceDataField.dataOnly, true);
    assert.equal(sourceDataField.sourceProps.metadataAttributes.canDisplay, "false");
    assert.equal(dslDataField.dataOnly, true);
    assert.equal(editSource.displayGate, "xform:editShow");
    assert.deepEqual(viewAction.runWhen, { viewStatusIn: ["view"] });
    assert.equal(prompt.context.allowedPatchPaths.some((path) => path.includes("dataOnly")), false);
    assert.equal(prompt.context.allowedPatchPaths.some((path) => path.includes("runWhen")), false);
    assert.equal(prompt.system.includes("runWhen is immutable"), true);
    assert.equal(prompt.system.includes("A view-gated action must retain executable JavaScript and cannot be omitted"), false);
    assert.equal(prompt.system.includes("versioned view-status-formula projection"), true);
    assert.equal(prompt.system.includes("conditionSource is event:value"), true);
    assert.equal(prompt.system.includes("Keep runWhen on any residual JavaScript"), true);
    assert.equal(prompt.system.includes("Do not duplicate visible or required effects already covered by native formRules"), true);
    assert.equal(prompt.system.includes("A gated action may be omitted only when every effect is covered"), true);
    assert.equal(prompt.system.includes("every evidenced target and right-hand-side value branch"), true);
    assert.equal(prompt.system.includes("every evidenced show/hide and required/non-required state"), true);
    assert.equal(prompt.system.includes("does not support async or await syntax"), true);
    assert.equal(prompt.system.includes("synchronously return true or false"), true);
    assert.equal(prompt.system.includes("read rows from its values array"), true);
  });
});
