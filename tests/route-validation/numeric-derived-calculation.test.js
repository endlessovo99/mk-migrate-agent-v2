import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sourceNumberEditors } from "../../src/dsl/source-number-editor.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const fixture = "tests/fixtures/route-validation/numeric-derived-calculation/numeric-derived-calculation_SysFormTemplate.xml";
const field = (dsl, id) => dsl.form.fields.find((entry) => entry.id === id);
function stages() {
  const source = cleanSourceFile(fixture);
  const draft = draftSourceDraft(source);
  const trusted = createTrustedMigrationDsl(source, draft, {
    externalAgentReviewed: true,
    reviewerName: "numeric-derived-calculation-route",
    checkedAt: "2026-10-15T00:00:00.000Z"
  });
  return { source, draft, trusted };
}
function assertTrusted(source, trusted) {
  const result = checkTrust(source, trusted);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
}

describe("numeric editor source with fixed derived calculation", () => {
  it("accepts the fixed-source calculate mapping without requiring an editable number profile", () => {
    const { source, draft, trusted } = stages();
    const raw = source.form.controls.find((entry) => entry.id === "fd_total");
    assert.equal(raw.sourceType, "number");
    assert.equal(raw.sourceProps.designerType, "inputText");
    assert.equal(raw.sourceProps.designerValues.dataType, "Double");
    assert.equal(raw.sourceProps.metadataAttributes.formula, "true");
    assert.deepEqual([...sourceNumberEditors(source.form).keys()], ["fd_total", "fd_input"]);
    assert.equal(field(draft, "fd_total").componentId, "xform-calculate");
    assert.deepEqual(field(draft, "fd_total").props.calculation, {
      kind: "formula", expression: "$fd_input$ * 2", fieldIds: ["fd_input"]
    });
    assert.deepEqual([...sourceNumberEditors(draft.form).keys()], ["fd_input"]);
    assertTrusted(source, trusted);
    assert.equal(checkExecute(trusted).ok, true);
    assert.equal(buildDryRunPlan(trusted).ok, true);
  });

  for (const [name, change] of [
    ["calculate restored to number", (dsl) => { field(dsl, "fd_total").componentId = "xform-number"; }],
    ["derived calculation deleted", (dsl) => { delete field(dsl, "fd_total").props.calculation; }],
    ["derived precision changed", (dsl) => { field(dsl, "fd_total").props.precision = 0; }],
    ["derived readonly invented", (dsl) => { field(dsl, "fd_total").props.readOnly = true; }],
    ["calculate washed into an editor", (dsl) => {
      field(dsl, "fd_total").componentId = "xform-number";
      delete field(dsl, "fd_total").props.calculation;
    }],
    ["fixed formula metadata removed", (dsl) => {
      delete field(dsl, "fd_total").sourceProps.metadataAttributes.formula;
      delete field(dsl, "fd_total").sourceProps.metadataAttributes.defaultValue;
    }],
    ["editable readonly invented", (dsl) => { field(dsl, "fd_input").props.readOnly = true; }],
    ["editable precision changed", (dsl) => { field(dsl, "fd_input").props.precision = 0; }],
    ["editable source width deleted", (dsl) => { delete field(dsl, "fd_input").sourceProps.designerValues.width; }],
    ["editable calculation invented", (dsl) => {
      field(dsl, "fd_input").componentId = "xform-calculate";
      field(dsl, "fd_input").props.calculation = { kind: "formula", expression: "$fd_total$ * 2", fieldIds: ["fd_total"] };
    }]
  ]) it(`rejects candidate ${name} against the green fixed source`, () => {
    const { source, trusted } = stages();
    assertTrusted(source, trusted);
    change(trusted);
    const result = checkTrust(source, trusted);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((item) => item.code === "trust.form.number_editor_source_mismatch"), JSON.stringify(result.diagnostics));
  });

  it("retains the XML to trusted DSL to native readback and transfer-record route", async () => {
    await withNetworkGuard(async () => {
      const { source, trusted } = stages();
      assertTrusted(source, trusted);
      const adapter = new FakeNewoaAdapter("persist", { templateAuthorization: trusted.template.authorization });
      const result = await executeDsl(trusted, {
        client: adapter,
        confirmWrite: true,
        targetCategoryId: "route-category-id",
        credentials: { username: "route-test-user", encryptedPassword: "route-test-encrypted-password" },
        now: new Date("2026-10-15T00:00:00.000Z")
      });
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(result.readback.ok, true);
      assert.equal(result.transferRecord.status, "recorded");
    });
  });
});
