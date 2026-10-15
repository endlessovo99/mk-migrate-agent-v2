import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { parseRootHashMap } from "../../src/translator/xml-utils.js";
import { executeDsl } from "../../src/executor/execute.js";
import { resolveWorkflowCooperation } from "../../src/executor/workflow-cooperation.js";
import { resolveWorkflowSignPolicy } from "../../src/executor/workflow-sign-policy.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { runRouteCase } from "./run-route-case.js";
import { prepareSample } from "../helpers/persistence.js";

const directory = "tests/fixtures/route-validation/workflow-sign";
const entity = JSON.parse(readFileSync(`${directory}/operation-set.json`));
const policy = JSON.parse(readFileSync(`${directory}/sign-policy.json`));
const source = cleanSourceFile(directory), draft = draftSourceDraft(source);
const trusted = () => createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
const options = { ...policy, confirmWrite: true, targetCategoryId: "route-category", credentials: { username: "fixture-user", encryptedPassword: "fixture-encrypted-password" },
  now: new Date("2026-07-10T00:00:00Z"), transferRecordIdFactory: () => "fixture-record" };
const client = () => new FakeNewoaAdapter("persist", { workflowCooperationDefault: "3", workflowOperationSets: [entity],
  organizationCandidates: [{ fdId: "post-a", fdName: "Post-A", fdOrgType: 4 }] });
const sign = dsl => dsl.workflow.nodes.filter(node => node.sourceType === "signNode");
const operations = adapter => adapter.transcript().map(row => row.operation);
function variant(change) {
  const path = mkdtempSync(join(tmpdir(), "source-sign-"));
  try {
    for (const file of ["sign_SysFormTemplate.xml", "sign_LbpmProcessDefinition.xml"]) {
      const xml = readFileSync(`${directory}/${file}`, "utf8");
      writeFileSync(join(path, file), file.includes("Lbpm") ? change(xml) : xml);
    }
    const source = cleanSourceFile(path); return { source, dsl: draftSourceDraft(source) };
  } finally { rmSync(path, { recursive: true, force: true }); }
}

it("retains six source sign identities, references, document values and typed participants through the full route", async () => {
  assert.equal(checkDraft(draft).ok, true);
  assert.deepEqual(sign(draft).map(node => node.type), Array(6).fill("sign"));
  assert.deepEqual(sign(source).map(node => node.definition.operations[0].attributes.refId), Array(6).fill("fixture-source-operations"));
  assert.deepEqual(sign(draft).map(node => node.definition.attributes.canModifyMainDoc), ["true", "false", "false", "true", "true", "true"]);
  assert.equal(sign(source).reduce((n, node) => n + node.handlerEntities.length, 0), 8);
  const result = await runRouteCase("source-sign-explicit-policy-success");
  assert.equal(result.execution.ok, true); assert.equal(result.execution.readback.status, "verified");
  assert.equal(result.execution.transferRecord.status, "recorded");
  assert.equal(result.transcript.filter(row => row.operation === "get-workflow-operation-set").length, 2);
  const audit = result.execution.apiStages.find(stage => stage.name === "resolveWorkflowSignPolicy");
  assert.ok(audit.documentAudit.every(row => row.disposition === "audit-only" && row.targetPermissionMapped === false));
  assert.deepEqual(sign(result.dsl).map(node => node.definition.attributes.canModifyMainDoc), audit.documentAudit.map(row => row.sourceValue));
  assert.equal(result.execution.diagnostics.filter(row => row.code === "workflow.sign.explicit_policy_applied").length, 1);
});

for (const [label, mutate] of [
  ["deleted operation evidence", node => delete node.definition.operations],
  ["changed operation reference", node => node.definition.operations[0].attributes.refId = "other"],
  ["deleted document value", node => delete node.definition.attributes.canModifyMainDoc],
  ["weakened document value", node => node.definition.attributes.canModifyMainDoc = "false"],
  ["replaced type", node => node.type = "review"],
  ["removed source type", node => delete node.sourceType],
  ["removed member", node => node.participants.members.pop()],
  ["changed member type", node => node.participants.members[0].targetOrgType = 4],
  ["alternative-only override", node => node.participants.useAlternativeOnly = true],
  ["other permission override", node => node.definition.attributes.canModifyFlow = "true"],
  ["invented e-sign skip override", node => node.eSignConfig = { enable: true }]
]) it(`rejects candidate ${label} against immutable SourceDraft`, () => {
  const candidate = structuredClone(draft); mutate(sign(candidate)[0]);
  const result = checkTrust(source, createTrustedMigrationDsl(source, candidate, { externalAgentReviewed: true }));
  assert.equal(result.ok, false); assert.ok(result.diagnostics.some(row => row.code.startsWith("workflow.sign.")), label);
});

for (const [label, change] of [
  ["missing ref", xml => xml.replaceAll('refId="fixture-source-operations"', '')],
  ["duplicate ref attribute", xml => xml.replace('refId="fixture-source-operations"', 'refId="fixture-source-operations" refId="other"')],
  ["unknown child", xml => xml.replace('&lt;operations refId="fixture-source-operations" /&gt;', '&lt;unexpected refId="fixture-source-operations" /&gt;')],
  ["unknown document value", xml => xml.replace('canModifyMainDoc="true"', 'canModifyMainDoc="unknown"')],
  ["direct definition conflict", xml => xml.replace('&lt;signNode id="S1"', '&lt;signNode canModifyMainDoc="false" id="S1"')],
  ["duplicate operation element", xml => xml.replace('&lt;operations refId="fixture-source-operations" /&gt;', '&lt;operations refId="fixture-source-operations" /&gt;&lt;operations refId="fixture-source-operations" /&gt;')],
  ["definition trailing text", xml => xml.replace('&lt;operations refId="fixture-source-operations" /&gt;', '&lt;operations refId="fixture-source-operations" /&gt;unknown-root-text')],
  ["definition leading text", xml => xml.replace('&lt;operations refId="fixture-source-operations" /&gt;', 'unknown-root-text&lt;operations refId="fixture-source-operations" /&gt;')],
  ["definition root CDATA", xml => xml.replace('&lt;operations refId="fixture-source-operations" /&gt;', '&lt;operations refId="fixture-source-operations" /&gt;&lt;![CDATA[unknown-root-text]]&gt;')],
  ["process review with sign definition", xml => xml.replace('&lt;signNode id="S1"', '&lt;reviewNode id="S1"')],
  ["process sign with review definition", xml => {
    let occurrence = 0;
    return xml.replaceAll('&lt;signNode id="S1"', match => ++occurrence === 2 ? '&lt;reviewNode id="S1"' : match)
      .replace('&lt;/signNode&gt;', '&lt;/reviewNode&gt;');
  }],
  ["duplicate root document attribute", xml => xml.replace('canModifyMainDoc="true"', 'canModifyMainDoc="true" canModifyMainDoc="false"')],
  ["duplicate direct recalculation attribute", xml => xml.replace('recalculateHandler="true"', 'recalculateHandler="true" recalculateHandler="false"')],
  ["duplicate direct document attribute with matching last value", xml => xml.replace('&lt;signNode id="S1"', '&lt;signNode canModifyMainDoc="false" canModifyMainDoc="true" id="S1"')],
  ["wrong operation element case", xml => xml.replace('&lt;operations ', '&lt;Operations ')],
  ["definition text after closing root", xml => xml.replace('&lt;/signNode&gt;', '&lt;/signNode&gt;unknown-envelope-text')]
]) it(`keeps unsupported source ${label} blocked`, () => {
  const { source: changed, dsl } = variant(change);
  assert.equal(checkExecute(createTrustedMigrationDsl(changed, dsl, { externalAgentReviewed: true })).ok, false);
});

for (const [label, mutate] of [
  ["missing document policy", value => delete value.workflowSignDocumentPolicy],
  ["wrong document policy", value => value.workflowSignDocumentPolicy = "ignore-permissions"],
  ["missing operation mapping", value => delete value.workflowOperationSetOverrides],
  ["unmatched operation reference", value => value.workflowOperationSetOverrides[0].sourceOperationRefId = "unmatched"],
  ["changed digest", value => value.workflowOperationSetOverrides[0].expectedSemanticDigest = `sha256:${"0".repeat(64)}`],
  ["missing cooperation default", value => delete value.workflowCooperationDefault]
]) it(`makes no template write with ${label}`, async () => {
  const configured = { ...options, ...structuredClone(policy) }; mutate(configured); const adapter = client();
  const result = await executeDsl(trusted(), { ...configured, client: adapter });
  assert.equal(result.ok, false);
  assert.equal(result.stage, label === "missing cooperation default" ? "resolveWorkflowCooperation" : "resolveWorkflowSignPolicy");
  assert.ok(!operations(adapter).some(op => ["add", "update", "save-workflow-draft", "add-transfer-record"].includes(op)));
});

it("blocks current cooperation default drift before template creation", async () => {
  const adapter = client(); adapter.workflowCooperationDefault = "2";
  const result = await executeDsl(trusted(), { ...options, client: adapter });
  assert.equal(result.ok, false); assert.equal(result.stage, "resolveWorkflowCooperation");
  assert.ok(!operations(adapter).includes("add"));
});

for (const phase of ["before", "after"]) for (const [label, mutate] of [
  ["wrong node type", value => value.fdNodeType = "review"],
  ["wrong flow", value => value.fdFlowType = "1"],
  ["wrong default", value => value.fdIsDefault = false],
  ["lost sign operation", value => value.fdOperations.splice(3, 1)],
  ["changed opinion required", value => { const attrs = JSON.parse(value.fdOperations[3].fdAttributes); attrs.find(item => item.id === "isContentRequired").value = false; value.fdOperations[3].fdAttributes = JSON.stringify(attrs); }]
]) it(`blocks ${phase}-write effective-operation drift: ${label}`, async () => {
  const adapter = client(), original = adapter.getWorkflowOperationSet.bind(adapter); let calls = 0;
  adapter.getWorkflowOperationSet = async id => { const value = await original(id); if (++calls === (phase === "before" ? 1 : 2)) mutate(value); return value; };
  const result = await executeDsl(trusted(), { ...options, client: adapter });
  assert.equal(result.ok, false); assert.ok(!operations(adapter).includes("add-transfer-record"));
  if (phase === "before") { assert.equal(result.stage, "resolveWorkflowSignPolicy"); assert.ok(!operations(adapter).includes("add")); }
  else { assert.equal(result.status, "readback_failed"); assert.equal(result.readback.ok, false); assert.equal(calls, 2); }
});

for (const [label, mutate, nodeId = "S1"] of [
  ["type", node => node.type = "review"], ["element", node => node.element = "robot"],
  ["operation ref", node => node.operationRefId = "custom"], ["inline operation", node => node.operations.push({ type: "handler_pass" })],
  ["empty handler", node => node.emptyHandlerType = 1], ["recalculate", node => node.recalculateHandler = "false"],
  ["flow permission", node => node.canModifyProcess = "true"], ["comment permission", node => node.canModifyCommentViewPermission = "true"],
  ["main-document permission", node => node.canModifyMainDoc = "false"], ["alternative-only", node => node.isUseAlternativeHandlerOnly = "true"],
  ["member deletion", node => node.handlers.members.pop()], ["member kind", node => node.handlers.members[0].type = "3"],
  ["skip", node => node.ignoreOnSameIdentity = "2"], ["timeout", node => node.dayOfNotify = "0"],
  ["post member kind", node => node.handlers.members[0].type = "1", "S2"],
  ["recalculate wrong native type", node => node.recalculateHandler = true],
  ["allow attachments", node => node.allowUploadAttachments = "false"],
  ["required", node => node.required = false],
  ["required native type", node => node.required = "true"],
  ["modify process authority", node => node.modifyProcessAuthority = "0"],
  ["open modify process authority", node => node.openModifyProcessAuthority = "false"],
  ["open node authority", node => node.openNodeAuthority = "false"],
  ["node authority", node => node.nodeAuthority = "0"],
  ["mobile availability", node => node.allowMobileHandle = "false"],
  ["ding availability", node => node.allowSendDing = "false"],
  ["form selection", node => node.formKey = "other"],
  ["check permission", node => node.checkPermission = { fdType: "none" }],
  ["scene mode", node => node.fdScene = { fdMode: 1 }],
  ["data authority switch", node => node.openDataAuthority = !node.openDataAuthority],
  ...["hourOfNotify", "minuteOfNotify", "dayOfPass", "hourOfPass", "minuteOfPass", "tranNotifyDraft", "hourOfTranNotifyDraft", "minuteOfTranNotifyDraft", "tranNotifyPrivate", "hourOfTranNotifyPrivate", "minuteOfTranNotifyPrivate"].map(key => [`timeout ${key}`, node => { node[key] = "99"; }])
]) it(`rejects independent native ${label} mismatch and does not record`, async () => {
  const adapter = client(), read = adapter.getWorkflowTemplateDetail.bind(adapter);
  adapter.getWorkflowTemplateDetail = async args => {
    const detail = await read(args), content = JSON.parse(detail.fdContent);
    mutate(content.elements.find(node => node.id === nodeId));
    detail.fdContent = JSON.stringify(content);
    adapter.template.mechanisms.lbpmTemplate[0].fdContent = detail.fdContent;
    return detail;
  };
  const result = await executeDsl(trusted(), { ...options, client: adapter });
  assert.equal(result.ok, false); assert.equal(result.status, "readback_failed");
  assert.ok(!operations(adapter).includes("add-transfer-record"));
});

it("preserves source cooperation/skip and all twelve timeout values without mapping main-document permission", async () => {
  const adapter = client();
  const cooperative = await resolveWorkflowCooperation(trusted(), { client: adapter, workflowCooperationDefault: "3" });
  const resolved = await resolveWorkflowSignPolicy(cooperative.dsl, { ...policy, client: adapter });
  // Local projection only; explicit source participants are checked separately by the executor route.
  resolved.dsl.workflow.nodes.find(node => node.id === "S2").participants.members[0].id = "post-a";
  const prepared = prepareSample(resolved.dsl), native = JSON.parse(prepared.update.mechanisms.lbpmTemplate[0].fdContent).elements.filter(node => node.type === "sign");
  assert.deepEqual(native.map(node => node.cooperateType), ["1", "1", "3", "3", "2", "3"]);
  assert.deepEqual(native.map(node => node.ignoreOnSameIdentity), ["1", "2", "3", "1", "1", "1"]);
  for (const node of native) {
    assert.equal(Object.hasOwn(node, "canModifyMainDoc"), false);
    assert.equal(node.emptyHandlerType, 2);
    assert.equal(node.migrationSource.definition.attributes.canModifyMainDoc, sign(draft).find(value => value.id === node.id).definition.attributes.canModifyMainDoc);
    for (const key of ["dayOfNotify", "hourOfNotify", "minuteOfNotify", "dayOfPass", "hourOfPass", "minuteOfPass", "tranNotifyDraft", "hourOfTranNotifyDraft", "minuteOfTranNotifyDraft", "tranNotifyPrivate", "hourOfTranNotifyPrivate", "minuteOfTranNotifyPrivate"]) {
      assert.equal(node[key], sign(draft).find(value => value.id === node.id).definition.attributes[key]);
    }
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("retains unsupported operation-body presence without copying unknown payload text into the DSL", () => {
  const { source: changed, dsl } = variant(xml => xml.replace('&lt;operations refId="fixture-source-operations" /&gt;',
    '&lt;operations refId="fixture-source-operations"&gt;fixture-sensitive-unsupported-body&lt;/operations&gt;'));
  assert.equal(JSON.stringify(changed).includes("fixture-sensitive-unsupported-body"), false);
  assert.equal(sign(changed)[0].definition.operations[0].text, "[unsupported operation content]");
  assert.equal(checkDraft(dsl).ok, false);
});

it("keeps existing required, handler-link and e-sign skip restrictions for sign projections", async () => {
  const adapter = client();
  const cooperative = await resolveWorkflowCooperation(trusted(), { client: adapter, workflowCooperationDefault: "3" });
  const resolved = await resolveWorkflowSignPolicy(cooperative.dsl, { ...policy, client: adapter });
  resolved.dsl.workflow.nodes.find(node => node.id === "S2").participants.members[0].id = "post-a";
  for (const mutate of [
    node => node.dataAuthority = { fields: { fd_note: { visible: true, editable: true, required: true } } },
    node => node.attributes.mustModifyHandlerNodeIds = "S3",
    node => node.attributes.canModifyHandlerNodeIds = "S3",
    node => node.eSignConfig = { enable: true }
  ]) {
    const dsl = structuredClone(resolved.dsl); mutate(dsl.workflow.nodes.find(node => node.id === "S2"));
    const prepared = prepareSample(dsl), native = JSON.parse(prepared.update.mechanisms.lbpmTemplate[0].fdContent).elements;
    assert.equal(native.find(node => node.id === "S2").ignoreOnSameIdentity, "1");
    assert.equal(prepared.verify(prepared.update).ok, true);
  }
});

it("rejects a caller-supplied resolved sign reference at the public DSL boundary", () => {
  const candidate = structuredClone(draft); sign(candidate)[0].operationRefId = entity.fdId;
  const forged = createTrustedMigrationDsl(source, candidate, { externalAgentReviewed: true });
  assert.equal(checkTrust(source, forged).ok, false);
  const checked = checkExecute(forged);
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some(row => row.code === "dsl.workflow.sign_runtime_reference_forbidden"));
});

it("rejects deletion of fixed-source handler ambiguity even after candidate promotion", () => {
  const { source: ambiguous, dsl } = variant(xml => {
    const root = parseRootHashMap(xml), extra = structuredClone(root.nodeDefinitionHandlers[0]);
    extra.fdHandler.fdId = "person-conflict";
    root.nodeDefinitionHandlers.push(extra);
    const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const encode = value => Array.isArray(value)
      ? `<object class="java.util.ArrayList">${value.map(item => `<void method="add">${encode(item)}</void>`).join("")}</object>`
      : value && typeof value === "object"
        ? `<object class="java.util.HashMap">${Object.entries(value).map(([key, item]) => `<void method="put"><string>${escape(key)}</string>${encode(item)}</void>`).join("")}</object>`
        : typeof value === "number" ? `<int>${value}</int>` : `<string>${escape(value)}</string>`;
    return `<java class="java.beans.XMLDecoder">${encode(root)}</java>`;
  });
  const fixed = ambiguous.workflow.nodes.find(node => node.id === "S1");
  assert.ok(fixed.directTargetAmbiguities.length);
  const candidate = structuredClone(dsl), node = candidate.workflow.nodes.find(node => node.id === "S1");
  delete node.directTargetAmbiguities; node.translationStatus = "executable";
  const check = checkTrust(ambiguous, createTrustedMigrationDsl(ambiguous, candidate, { externalAgentReviewed: true }));
  assert.equal(check.ok, false);
  assert.ok(check.diagnostics.some(row => row.code === "workflow.sign.source_handler_ambiguous"));
});

it("does not let a candidate erase a sign declaration present only on the definition side", () => {
  const { source: conflict, dsl } = variant(xml => xml.replace('&lt;signNode id="S1"', '&lt;reviewNode id="S1"'));
  const candidate = structuredClone(dsl), node = candidate.workflow.nodes.find(item => item.id === "S1");
  node.type = "review"; node.sourceType = "reviewNode"; node.definition.sourceType = "reviewNode";
  delete node.definition.operations; node.translationStatus = "executable";
  const result = checkTrust(conflict, createTrustedMigrationDsl(conflict, candidate, { externalAgentReviewed: true }));
  assert.equal(result.ok, false); assert.ok(result.diagnostics.some(row => row.code === "workflow.sign.source_node_invalid"));
});

it("accepts complete whitespace/comment roots and quoted attribute values without false duplicate names", () => {
  const { source: valid, dsl } = variant(xml => xml
    .replace('&lt;operations refId="fixture-source-operations" /&gt;', '&lt;!-- root note --&gt; &lt;operations refId="fixture-source-operations"&gt;  &lt;/operations&gt; &lt;!-- end note --&gt;')
    .replace('&lt;signNode id="S1"', '&lt;signNode description="literal key=first key=second" id="S1"'));
  assert.equal(checkTrust(valid, createTrustedMigrationDsl(valid, dsl, { externalAgentReviewed: true })).ok, true);
  assert.equal(valid.workflow.nodes.find(node => node.id === "S1").signSourceIssues, undefined);
});
