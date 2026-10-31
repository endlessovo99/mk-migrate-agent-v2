import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { attachMigrationPolicies, migrationPolicySourceDigest } from "../../src/translator/approved-migration-policies.js";
import { sha256Digest } from "../../src/agent-review/digest.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { prepareSample, formAttr, xformConfig } from "../helpers/persistence.js";
import { nativeRequiredRuntime } from "../helpers/native-required-runtime.js";
import { markedDispatcherActionFunction } from "../../src/executor/persistence/script-dispatcher-contract.js";

const fixture = "tests/fixtures/route-validation/required-permissions/route-required-permissions_SysFormTemplate.xml";
const scope = { baseUrl: "https://qas.example.invalid", targetCategoryId: "fixture-category" };

it("surfaces the source conflict for review without forcing optional columns", () => {
  const draft = draftSourceDraft(cleanSourceFile(fixture));
  const warning = draft.review.warnings.find(item => item.code === "source.form.detail_conditional_required_ambiguous");
  assert.deepEqual(warning.details.fields.map(field => field.id), ["fd_note"]);
  assert.equal(draft.form.fields.find(field => field.id === "fd_rows").columns.find(field => field.id === "fd_note").props.required, false);
});

function prepare(decisionOverrides = {}) {
  const raw = cleanSourceFile(fixture);
  const decision = {
    kind: "confirmed-detail-required", id: "confirmed-note",
    sourceRef: "source.form.detailTable.fd_rows.column.fd_note",
    ruleId: "linkage.fd_seal.contains.YES",
    ...decisionOverrides
  };
  const source = attachMigrationPolicies(raw, {
    version: 1, sourceDraftSha256: migrationPolicySourceDigest(raw), scope,
    authorization: { actor: "fixture-only", evidenceSha256: sha256Digest("Synthetic business confirmation") },
    decisions: [decision]
  }, scope);
  return { source, draft: draftSourceDraft(source) };
}

it("enables only the confirmed detail column under its existing conditional row rule", () => {
  const { source, draft } = prepare();
  const columns = draft.form.fields.find(field => field.id === "fd_rows").columns;
  assert.equal(columns.find(field => field.id === "fd_note").props.required, true);
  for (const action of draft.scripts.actions.filter(action => action.id.startsWith("policy.detail-required."))) {
    assert.equal(action.semanticHints.coveredCalculationRanges, undefined,
      "A supplemental required check must not claim the original source script is fully translated");
  }
  assert.equal(draft.review.warnings.some(item => item.code === "source.form.detail_conditional_required_ambiguous"), false);
  assert.equal(draft.form.fields.find(field => field.id === "fd_intro_org").props.required, false);
  const prepared = prepareSample(draft), config = xformConfig(prepared.update);
  const table = config.dataModel.find(model => model.fdType === "detail").fdTableName;
  const main = config.dataModel.find(model => model.fdType === "main").fdTableName;
  const rules = formAttr(prepared.update).formRule.require;
  const result = branch => rules.find(rule => rule.meta.sourceRuleId === "linkage.fd_seal.contains.YES" && rule.meta.branch === branch)
    .result.find(item => item.fieldName === "fd_note");
  assert.equal(result("when").required, "required");
  assert.equal(result("else").required, "non-required");
  for (const scene of ["add", "edit"]) {
    const runtime = nativeRequiredRuntime(structuredClone(config), scene);
    const actions = formAttr(prepared.update).controlAction;
    const owner = actions.global.onLoad[0];
    const load = owner.migrationActions.find(action => action.id === "policy.detail-required.confirmed-note.onLoad");
    const loadFunction = markedDispatcherActionFunction(owner.function, load.name);
    const onLoad = new Function("MKXFORM", `return (${loadFunction});`)(runtime.MKXFORM);
    const change = actions.control[`${main}.fd_seal`].onChange.find(action => action.id === "policy.detail-required.confirmed-note.onChange");
    const onChange = new Function("MKXFORM", `return (${change.function});`)(runtime.MKXFORM);
    for (const value of ["NO", "YES", "NO", "YES"]) {
      runtime.MKXFORM.setValue("fd_seal", value);
      onLoad();
      assert.equal(runtime.detailRequired(table, "fd_note"), value === "YES");
      onChange(value);
      assert.equal(runtime.detailRequired(table, "fd_note"), value === "YES");
      assert.equal(runtime.required("fd_intro_org"), false);
    }
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  assert.equal(checkTrust(source, trusted).ok, true);
  const changedAction = structuredClone(trusted);
  changedAction.scripts.actions.find(action => action.id === "policy.detail-required.confirmed-note.onLoad").function = "function onLoad() {}";
  assert.equal(checkTrust(source, changedAction).ok, false);
  trusted.form.fields.find(field => field.id === "fd_rows").columns.find(field => field.id === "fd_note").props.required = false;
  assert.equal(checkTrust(source, trusted).ok, false);
});

it("rejects a decision for an unrelated or unknown source field or rule", () => {
  for (const overrides of [
    { sourceRef: "source.form.detailTable.fd_rows.column.missing" },
    { sourceRef: "source.form.control.fd_intro_org" },
    { ruleId: "missing-rule" }
  ]) assert.throws(() => prepare(overrides));
});

it("does not change a confirmed requirement in view mode", () => {
  const { draft } = prepare(), prepared = prepareSample(draft), config = xformConfig(prepared.update);
  const table = config.dataModel.find(model => model.fdType === "detail").fdTableName;
  const runtime = nativeRequiredRuntime(config), actions = formAttr(prepared.update).controlAction;
  const owner = actions.global.onLoad[0];
  const load = owner.migrationActions.find(action => action.id === "policy.detail-required.confirmed-note.onLoad");
  const fn = new Function("MKXFORM", `return (${markedDispatcherActionFunction(owner.function, load.name)});`)(runtime.MKXFORM);
  runtime.MKXFORM.viewStatus = "view";
  runtime.MKXFORM.setValue("fd_seal", "NO");
  fn();
  assert.equal(runtime.detailRequired(table, "fd_note"), true);
});

it("also follows a source rule owned by the translated change script", () => {
  const raw = cleanSourceFile("tests/fixtures/route-validation/submission-feedback/submission-feedback_SysFormTemplate.xml");
  const policy = { version: 1, sourceDraftSha256: migrationPolicySourceDigest(raw), scope,
    authorization: { actor: "synthetic", evidenceSha256: sha256Digest("Fixture approval") },
    decisions: [{ kind: "confirmed-detail-required", id: "confirmed-note",
      sourceRef: "source.form.detailTable.fd_people.column.fd_note", ruleId: "linkage.fd_mode.contains.YES" }] };
  const source = attachMigrationPolicies(raw, policy, scope), draft = draftSourceDraft(source);
  const prepared = prepareSample(draft), config = xformConfig(prepared.update);
  const main = config.dataModel.find(model => model.fdType === "main").fdTableName;
  const table = config.dataModel.find(model => model.fdType === "detail").fdTableName;
  const action = formAttr(prepared.update).controlAction.control[`${main}.fd_mode`].onChange[0];
  const runtime = nativeRequiredRuntime(config);
  const execute = new Function("MKXFORM", `return (${action.function});`)(runtime.MKXFORM);
  for (const value of ["YES", "NO", "YES"]) {
    execute(value);
    assert.equal(runtime.detailRequired(table, "fd_note"), value === "YES");
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
  const checked = checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true }));
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
});
