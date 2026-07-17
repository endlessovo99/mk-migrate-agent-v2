import assert from "node:assert/strict";
import { it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const source = "tests/fixtures/source/1927955f6e544383f46970f48468a743";

it("routes a nested JSP click handler to an executable MK button draft", () => {
  const dsl = draftSourceDraft(cleanSourceFile(source));
  const result = checkDraft(dsl);
  const button = dsl.form.fields.find((field) => field.componentId === "xform-button");
  const click = dsl.scripts.actions.find((action) =>
    action.controlId === button?.id && action.event === "onClick"
  );

  assert.equal(result.ok, true);
  assert.equal(button?.id, "fd_3d7f13d18ccc00");
  assert.equal(click?.translationStatus, "mapped");
  assert.deepEqual(click?.coverage, { status: "translated", nativeRules: [], residuals: [] });
});
