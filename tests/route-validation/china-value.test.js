import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkExecute } from "../../src/dsl/checks.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runRouteCase } from "./run-route-case.js";

const runtimeFixture =
  "tests/fixtures/route-validation/china-value-runtime/route-china-value-runtime_SysFormTemplate.xml";

describe("chinaValue Route-validation", { concurrency: false }, () => {
  it("persists a tracked chinaValue control as an xform-input text field", async () => {
    const result = await runRouteCase("form-only-success");

    const dslField = result.dsl.form.fields.find((field) => field.id === "fd_cny_upper");
    assert.ok(dslField);
    assert.equal(dslField.title, "CNY Uppercase");
    assert.equal(dslField.type, "text");
    assert.equal(dslField.componentId, "xform-input");
    assert.equal(dslField.sourceProps.designerType, "chinaValue");
    assert.equal(dslField.sourceProps.designerValues.relatedid, "fd_amount");
    assert.equal(dslField.sourceProps.metadataId, "fd_cny_upper");

    const readbackField = result.execution.readback.form.fields.find(
      (field) => field.id === "fd_cny_upper"
    );
    assert.ok(readbackField);
    assert.equal(readbackField.title, "CNY Uppercase");
    assert.equal(readbackField.type, "text");
    assert.equal(readbackField.component, "xform-input");
    assert.equal(readbackField.required, false);
    assert.equal(result.execution.readback.ok, true);
  });

  it("maps the legacy chinaValue runtime include to related amount synchronization", () => {
    const source = cleanSourceFile(runtimeFixture);
    const draft = draftSourceDraft(source);
    const actions = draft.scripts.actions.filter((action) =>
      action.functionMappings?.some((mapping) =>
        mapping.basis === "deterministic-china-value-runtime"
      )
    );

    assert.deepEqual(actions.map((action) => `${action.event}:${action.controlId || ""}`), [
      "onChange:fd_amount",
      "onLoad:"
    ]);
    for (const action of actions) {
      assert.equal(action.translationStatus, "mapped");
      assert.equal(action.coverage.status, "translated");
      assert.deepEqual(action.coverage.residuals, []);
      assert.match(action.function, /MKXFORM\.getValue\("fd_amount"\)/);
      assert.match(action.function, /MKXFORM\.setValue\("fd_amount_upper", chineseAmount\)/);
      assert.doesNotMatch(action.function, /Com_IncludeFile|chinaValue_script|XForm_GetChinaValue/);
    }

    const values = { fd_amount: 1.01 };
    const onChange = Function("MKXFORM", `${actions[0].function}; return onChange;`)({
      getValue(id) { return values[id]; },
      setValue(id, value) { values[id] = value; }
    });
    onChange();
    assert.equal(values.fd_amount_upper, "壹元零壹分");

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      decisions: actions.map((action) => ({
        path: `/scripts/actions/${draft.scripts.actions.indexOf(action)}`,
        decision: "accept",
        reason: "Source chinaValue relatedid and runtime include deterministically identify the synchronization."
      }))
    });
    assert.equal(checkExecute(trusted).ok, true);
    assert.equal(buildDryRunPlan(trusted).ok, true);
  });
});
