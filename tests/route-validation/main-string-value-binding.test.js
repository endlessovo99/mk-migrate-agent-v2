import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { mainStringValueBindingFacts } from "../../src/translator/main-string-value-binding.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const file = "tests/fixtures/route-validation/main-string-value-binding/route-main-string-value-binding_SysFormTemplate.xml";
const template = parseRootHashMapStringPuts(fs.readFileSync(file, "utf8"));
const raw = '<input type="hidden" name="extendDataFormInfo.value(fd_state)"/>';
const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function stages(changes) {
  if (!changes) { const source = cleanSourceFile(file); return { source, dsl: draftSourceDraft(source) }; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mk-main-binding-"));
  try {
    const xml = '<java><object class="java.util.HashMap">' + Object.entries({ ...template, ...changes })
      .map(([key, value]) => `<void method="put"><string>${key}</string><string>${escape(value)}</string></void>`).join("") + '</object></java>';
    const input = path.join(root, "route-main-binding_SysFormTemplate.xml");
    fs.writeFileSync(input, xml);
    const source = cleanSourceFile(input);
    return { source, dsl: draftSourceDraft(source) };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe("source singleton binding Route-validation", () => {
  it("binds verified facts through source cleaning and preserves singleton-list loose equality", () => {
    const { source, dsl } = stages();
    const state = dsl.form.fields.find(field => field.id === "fd_state");
    assert.equal(state.sourceProps.mainStringValueBindingFact.status, "verified");
    const action = dsl.scripts.actions[0];
    assert.equal(action.translationStatus, "mapped");
    for (const value of [undefined, "", "A", "B", "A,B"]) {
      const expected = [], observed = [], loads = [];
      vm.runInNewContext(source.scripts.sources[0].javascript, { window: {}, Com_AddEventListener(_w, _e, fn) { loads.push(fn); },
        GetXFormFieldValueById() { return value === undefined ? [] : [value]; },
        common_dom_row_set_show_required_reset(id, show, required) { expected.push([id, show ? 5 : 4], [id, required ? 3 : 6]); } });
      for (const load of loads) load();
      vm.runInNewContext(action.function + ';onLoad();', { MKXFORM: { getValue() { return value; }, setFieldAttr(id, attr) { observed.push([id, attr]); } } });
      assert.deepEqual(observed, expected);
    }
    assert.equal(checkDraft(dsl).ok, true);
  });

  it("blocks duplicate Designer/runtime bindings and absent runtime controls at every write gate", async () => {
    await withNetworkGuard(async () => {
      for (const changed of [
        { fdDesignerHtml: template.fdDesignerHtml + raw },
        { fdDesignerHtml: template.fdDesignerHtml + raw + raw },
        { fdDisplayJsp: template.fdDisplayJsp + raw },
        { fdDisplayJsp: template.fdDisplayJsp.replace(raw, "") }
      ]) {
        assert.equal(mainStringValueBindingFacts({ ...template, ...changed }).fd_state.status, "unproven");
        const { source, dsl } = stages(changed);
        assert.equal(dsl.scripts.actions[0].translationStatus, "needs_review");
        // A structurally valid draft may retain pending actions; execution may not.
        assert.equal(checkDraft(dsl).ok, true);
        assert.equal(dsl.trust.executable, false);
        const trusted = createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true, reviewerName: "binding-route-fixture" });
        assert.equal(checkTrust(source, trusted).ok, false);
        assert.equal(validateMigrationDsl(trusted, { mode: "execute" }).ok, false);
        assert.equal(buildDryRunPlan(trusted).ok, false);
        const client = new FakeNewoaAdapter("persist");
        const result = await executeDsl(trusted, { client, confirmWrite: true, targetCategoryId: "route-category-id",
          credentials: { username: "route-fixture", encryptedPassword: "route-fixture-password" } });
        assert.equal(result.ok, false);
        assert.deepEqual(client.transcript(), []);
      }
    });
  });

  it("rejects altered or removed source binding facts at the trust boundary", () => {
    const { source, dsl } = stages();
    const trusted = createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true, reviewerName: "binding-route-fixture" });
    assert.equal(checkTrust(source, trusted).ok, true);
    for (const mutate of [
      field => { field.sourceProps.mainStringValueBindingFact.sourceHashes.fdDisplayJsp = "0".repeat(64); },
      field => { field.sourceProps.mainStringValueBindingFact.surfaces.display.logicalBindingCount = 2; },
      field => { delete field.sourceProps.mainStringValueBindingFact; }
    ]) {
      const changed = structuredClone(trusted);
      mutate(changed.form.fields.find(field => field.id === "fd_state"));
      const result = checkTrust(source, changed);
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "trust.form.main_string_binding_source_mismatch"));
    }
  });
});
