import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { executeDsl } from "../../src/executor/execute.js";
import { publishedFormSnapshotDigest } from "../../src/executor/published-form-patch.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

describe("published form patch Route", () => {
  it("accepts a regenerated profile only in native form metadata while still protecting workflow and field descriptors", async (t) => {
    for (const mutation of ["none", "field", "workflow"]) {
      const { dsl, client, options } = setup(t);
      const oldProfile = "a".repeat(32), newProfile = "b".repeat(32);
      client.official.fdProfileId = oldProfile;
      const descriptor = (profile, name = "fd_bank") => "sys-xform:XFormComponent:" + JSON.stringify({ fdProfileId: profile, fdName: name, fdVersionId: "official-version" });
      const workflow = client.template.mechanisms.lbpmTemplate[0];
      workflow.fdFormFields = { [client.template.fdId]: { properties: { fd_bank: { $ref: descriptor(oldProfile) } } } };
      workflow.defaultFormMetaData = { properties: { fd_bank: { features: { "com.landray.framework.meta.DialogArgument": { value: descriptor(oldProfile) } } } } };
      options.expectedSnapshotDigest = snapshotDigest(client);
      client.afterSave = () => {
        client.official.fdProfileId = newProfile;
        const config = JSON.parse(client.official.fdConfig);
        Object.assign(config.viewModel[0], { fdAlter: { fdId: "editor" }, fdAlterTime: 1000 });
        client.official.fdConfig = JSON.stringify(config);
        workflow.fdFormFields[client.template.fdId].properties.fd_bank.$ref = descriptor(newProfile);
        workflow.defaultFormMetaData.properties.fd_bank.features["com.landray.framework.meta.DialogArgument"].value = descriptor(newProfile, mutation === "field" ? "different_field" : "fd_bank");
        if (mutation === "workflow") workflow.fdContent = "modified workflow";
      };
      const result = await executeDsl(dsl, options);
      assert.equal(result.ok, mutation === "none", JSON.stringify(result.readback));
      assert.equal(client.calls.filter((name) => name === "saveOfficialForm").length, 1);
    }
  });

  it("refreshes transient mechanism tokens without recording them or ignoring real permission changes", async (t) => {
    for (const changeRights of [false, true]) {
      const { dsl, client, options } = setup(t);
      client.template.mechanisms["sys-auth"] = { mechAuthToken: "fixture-mechanism-token-old", canEdit: true };
      client.official.mechanisms["sys-auth"] = { mechAuthToken: "fixture-mechanism-token-old", canEdit: true };
      options.expectedSnapshotDigest = snapshotDigest(client);
      client.template.mechanisms["sys-auth"].mechAuthToken = "fixture-mechanism-token-new";
      client.official.mechanisms["sys-auth"].mechAuthToken = "fixture-mechanism-token-new";
      client.onSecondTemplateRead = () => {
        client.official.mechanisms["sys-auth"].mechAuthToken = "fixture-mechanism-token-fresh";
        if (changeRights) client.template.mechanisms["sys-auth"].canEdit = false;
      };
      const result = await executeDsl(dsl, options);
      assert.equal(result.ok, !changeRights);
      if (changeRights) assert.equal(client.calls.includes("saveOfficialForm"), false);
      else {
        assert.equal(client.savedPayload.mechanisms["sys-auth"].mechAuthToken, "fixture-mechanism-token-fresh");
        for (const name of ["before.template.json", "before.official-form.json", "save.payload.json", "after.official-form.json", "after.template.json"]) {
          assert.equal(readFileSync(join(options.artifactsDir, name), "utf8").includes("fixture-mechanism-token"), false);
        }
      }
    }
  });

  it("updates only selected readonly permissions and text normalization through the official form API", async (t) => {
    const { dsl, client, options } = setup(t);
    const before = structuredClone(client.template);
    const result = await executeDsl(dsl, options);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.createdFdIds, []);
    assert.deepEqual(result.updatedFdIds, [before.fdId]);
    assert.equal(client.calls.filter((name) => name === "saveOfficialForm").length, 1);
    assert.deepEqual(client.template, before);
    const config = JSON.parse(client.official.fdConfig);
    for (const mode of ["add", "edit"]) {
      for (const id of options.readonlyFieldIds) assert.equal(config.auth[0][mode].mk_model_test.fields[id].editable, false);
    }
    assert.equal(config.manualSetting.keep, true);
    const code = JSON.parse(config.attribute.formAttr).controlAction.global.onLoad[0].function;
    assert.match(code, /untouched = "keep"/);
    const states = [];
    new Function("MKXFORM", `${code};return onLoad;`)({ getValue: () => undefined, setFieldAttr: (...args) => states.push(args) })({});
    assert.ok(states.some(([id, state]) => id === "fd_external_name" && state === 4));
    assert.equal(JSON.parse(readFileSync(join(options.artifactsDir, "write-state.json"))).status, "verified");
  });

  it("keeps the normal executor draft gate and requires a matching snapshot and explicit patch scope", async (t) => {
    for (const override of [
      { publishedFormPatch: false }, { confirmWrite: false }, { expectedSnapshotDigest: "0".repeat(64) },
      { readonlyFieldIds: ["missing"] }, { scriptActionIds: ["missing"] }, { targetCategoryId: "other" }
    ]) {
      const { dsl, client, options } = setup(t);
      const result = await executeDsl(dsl, { ...options, ...override });
      assert.equal(result.ok, false, JSON.stringify(override));
      assert.equal(client.calls.includes("saveOfficialForm"), false);
    }
  });

  it("rejects a changed published version before writing", async (t) => {
    const { dsl, client, options } = setup(t);
    client.onSecondTemplateRead = () => { client.template.mechanisms["sys-xform"].fdVersionId = "new-version"; };
    const result = await executeDsl(dsl, options);
    assert.equal(result.ok, false);
    assert.equal(client.calls.includes("saveOfficialForm"), false);
  });

  it("does not overwrite a manually changed selected script", async (t) => {
    const { dsl, client, options } = setup(t);
    const config = JSON.parse(client.official.fdConfig);
    const attr = JSON.parse(config.attribute.formAttr);
    attr.controlAction.global.onLoad[0].function = attr.controlAction.global.onLoad[0].function.replace("'external'", "'manual'");
    config.attribute.formAttr = JSON.stringify(attr);
    client.official.fdConfig = JSON.stringify(config);
    options.expectedSnapshotDigest = snapshotDigest(client);
    const result = await executeDsl(dsl, options);
    assert.equal(result.ok, false);
    assert.equal(client.calls.includes("saveOfficialForm"), false);
  });

  it("records an uncertain save and never retries a used execution directory", async (t) => {
    const { dsl, client, options } = setup(t);
    client.failSave = true;
    const result = await executeDsl(dsl, options);
    assert.equal(result.ok, false);
    assert.equal(result.writeOutcomeUnknown, true);
    await executeDsl(dsl, options);
    assert.equal(client.calls.filter((name) => name === "saveOfficialForm").length, 1);
  });

  it("fails readback if an unrelated field or the workflow changes", async (t) => {
    for (const mutateWorkflow of [false, true]) {
      const { dsl, client, options } = setup(t);
      client.afterSave = () => {
        if (mutateWorkflow) client.template.mechanisms.lbpmTemplate[0].fdContent = "changed";
        else {
          const config = JSON.parse(client.official.fdConfig);
          config.manualSetting.keep = false;
          client.official.fdConfig = JSON.stringify(config);
        }
      };
      const result = await executeDsl(dsl, options);
      assert.equal(result.ok, false);
      assert.equal(result.status, "readback_failed");
      assert.equal(client.calls.filter((name) => name === "saveOfficialForm").length, 1);
    }
  });
});

function setup(t) {
  const source = cleanSourceFile("tests/fixtures/route-validation/published-form-patch/route-published-form-patch_SysFormTemplate.xml");
  const draft = draftSourceDraft(source);
  const action = draft.scripts.actions[0];
  action.function = "function onLoad() { var value = String(MKXFORM.getValue('fd_mode') ?? ''); if (value.indexOf('external') >= 0) { MKXFORM.setFieldAttr('external_row', 5); MKXFORM.setFieldAttr('external_row', 3); } else { MKXFORM.setFieldAttr('external_row', 4); MKXFORM.setFieldAttr('external_row', 6); } }";
  action.translationStatus = "mapped";
  action.coverage = { status: "translated", nativeRules: [], residuals: [] };
  action.functionMappings = [{ source: "legacy scalar text and row effects", target: "MKXFORM.getValue/setFieldAttr", basis: "semantic-translation", reviewRequired: false }];
  const dsl = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  assert.equal(checkTrust(source, dsl).ok, true);
  const old = structuredClone(dsl);
  for (const field of old.form.fields) delete field.props.readOnly;
  old.scripts.actions[0].function = action.function.replace("String(MKXFORM.getValue('fd_mode') ?? '')", "MKXFORM.getValue('fd_mode')");
  const template = prepareSample(old).update;
  const config = xformConfig(template);
  config.manualSetting = { keep: true };
  const attr = JSON.parse(config.attribute.formAttr);
  attr.controlAction.global.onLoad[0].function = attr.controlAction.global.onLoad[0].function.replace("function onLoad(context) {", 'function onLoad(context) {\n var untouched = "keep";');
  config.attribute.formAttr = JSON.stringify(attr);
  template.fdStatus = 2;
  Object.assign(template.mechanisms["sys-xform"], { fdStatus: "official", fdVersionId: "official-version", fdConfig: JSON.stringify(config) });
  Object.assign(template.mechanisms.lbpmTemplate[0], { fdStatus: "published", isDraft: false, fdContent: "protected workflow" });
  const official = { fdId: "official-version", fdXForm: { fdId: template.fdId }, fdEntityId: template.fdId, fdStatus: "official", fdVersion: 1, fdTableName: template.fdTableName, fdConfig: JSON.stringify(config), mechanisms: {} };
  const client = {
    template, official, calls: [], templateReads: 0,
    async login() { this.calls.push("login"); },
    async getTemplate() { this.calls.push("getTemplate"); if (++this.templateReads === 2) this.onSecondTemplateRead?.(); return structuredClone(this.template); },
    async getOfficialForm() { this.calls.push("getOfficialForm"); return structuredClone(this.official); },
    async saveOfficialForm(payload) {
      this.calls.push("saveOfficialForm");
      if (this.failSave) throw new Error("unknown transport outcome");
      assert.deepEqual(Object.keys(payload).sort(), ["fdConfig", "fdId", "mechanisms"]);
      assert.equal(payload.fdId, this.official.fdId);
      this.savedPayload = structuredClone(payload);
      this.official.fdConfig = payload.fdConfig;
      this.afterSave?.();
      return { fdId: payload.fdId };
    }
  };
  const root = mkdtempSync(join(tmpdir(), "published-form-route-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { dsl, client, options: { client, confirmWrite: true, publishedFormPatch: true, targetTemplateId: template.fdId, targetCategoryId: template.fdCategory.fdId, expectedSnapshotDigest: snapshotDigest(client), readonlyFieldIds: ["fd_bank", "fd_account"], scriptActionIds: [action.id], artifactsDir: join(root, "execution"), credentials: { username: "fixture-user", encryptedPassword: "fixture-secret" } } };
}

function snapshotDigest(client) {
  return publishedFormSnapshotDigest(client.template, client.official);
}
