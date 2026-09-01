import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

describe("Attachment native-required Route case", () => {
  it("persists and reads back the required field without a duplicate script", async () => {
    const result = await runRouteCase("attachment-native-required-success");
    const field = result.dsl.form.fields.find((candidate) => candidate.id === "fd_attach");
    const action = result.dsl.scripts.actions.find((candidate) =>
      candidate.recipe?.kind === "attachment_non_empty"
    );
    const observed = result.execution.readback.form.fields.find((candidate) =>
      candidate.id === "fd_attach"
    );

    assert.equal(field.props.required, true);
    assert.equal(action.translationStatus, "omitted");
    assert.deepEqual(action.runWhen, { viewStatusIn: ["add", "edit"] });
    assert.deepEqual(action.recipe.nativeRequiredEvidence, {
      contractVersion: 1,
      sourceShape: "active-file-submit-guard",
      displayGate: "xform:editShow"
    });
    assert.equal(observed.required, true);
    assert.equal(result.execution.readback.form.scripts.persistedActionCount, 0);
    assert.equal(result.execution.transferRecord.status, "recorded");
  });
});
