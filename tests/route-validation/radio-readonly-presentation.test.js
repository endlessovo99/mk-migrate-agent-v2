import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { buildRadioReadOnlyPresentationDecision, validateRadioReadOnlyPresentationDecisions, radioReadOnlyPresentationDslDiagnostics } from "../../src/translator/radio-readonly-presentation.js";
import { sha256Digest } from "../../src/agent-review/digest.js";
import { attachMigrationPolicies, migrationPolicySourceDigest } from "../../src/translator/approved-migration-policies.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const directory = "tests/fixtures/route-validation/radio-readonly-presentation";
const ids = ["fd_leader", "fd_supervisor"];
const scope = { baseUrl: "https://p-sit.onewo.com", targetCategoryId: "route-category-id" };
const field = (dsl, id) => dsl.form.fields.find(f => f.id === id);
function approved(source = cleanSourceFile(directory), selected = ids) {
  const policy = { version: 1, sourceDraftSha256: migrationPolicySourceDigest(source), scope,
    authorization: { actor: "hypothetical-fixture-only", evidenceSha256: sha256Digest("Sanitized fixture authorization; not a human approval.") },
    decisions: [buildRadioReadOnlyPresentationDecision(source, selected.map(id => source.form.controls.find(f => f.id === id).sourceRef))] };
  const authorized = attachMigrationPolicies(source, policy, scope);
  return { source: authorized, draft: draftSourceDraft(authorized) };
}
function changedSource(edit) {
  const template = parseSysFormTemplateXml(readFileSync(`${directory}/route-radio_SysFormTemplate.xml`, "utf8"));
  edit(template);
  const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const xml = '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
    Object.entries(template).map(([k, v]) => `<void method="put"><string>${escape(k)}</string><string>${escape(v)}</string></void>`).join("") + '</object></java>';
  const dir = mkdtempSync(join(tmpdir(), "radio-readonly-source-"));
  try {
    writeFileSync(join(dir, "route-radio_SysFormTemplate.xml"), xml);
    writeFileSync(join(dir, "route-radio_LbpmProcessDefinition.xml"), readFileSync(`${directory}/route-radio_LbpmProcessDefinition.xml`));
    return cleanSourceFile(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function nativeProps(payload, id) {
  const entry = xformConfig(payload).dataModel.flatMap(m => m.fdFields).find(f => f.fdName === id);
  return JSON.parse(entry.fdAttribute).config.controlProps;
}
function corruptNative(payload, id, edit) {
  const config = xformConfig(payload), entry = config.dataModel.flatMap(m => m.fdFields).find(f => f.fdName === id);
  const attr = JSON.parse(entry.fdAttribute);
  edit(attr.config.controlProps); entry.fdAttribute = JSON.stringify(attr);
  payload.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
}
it("reconstructs a unique native radio group without treating its two inputs as duplicate String bindings", () => {
  const source = cleanSourceFile(directory);
  for (const id of ids) {
    const f = source.form.controls.find(f => f.id === id);
    assert.equal(f.sourceProps.radioReadOnlySourceFact?.status, "verified");
    assert.equal(f.sourceProps.mainStringValueBindingFact.status, "unproven");
  }
});
it("projects approved readonly options while preserving the unapproved purchase and all empty defaults", () => {
  const { draft } = approved(), prepared = prepareSample(draft);
  for (const id of ids) {
    assert.equal(field(draft, id).props.readOnlyPresentation, "all-options");
    const native = xformConfig(prepared.update).dataModel.flatMap(m => m.fdFields).find(f => f.fdName === id);
    assert.equal(JSON.parse(native.fdAttribute).config.controlProps.showContent, "allItem");
    assert.equal(Object.hasOwn(field(draft, id).props, "defaultValue"), false);
  }
  assert.equal(field(draft, "fd_purchase").props.readOnlyPresentation, undefined);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("changes only the two presentation props and preserves complete source permissions, scripts, rules and layout", () => {
  const source = cleanSourceFile(directory), original = structuredClone(source), baseline = draftSourceDraft(source), { draft } = approved(source);
  const stripped = structuredClone(draft.form);
  for (const id of ids) delete stripped.fields.find(f => f.id === id).props.readOnlyPresentation;
  assert.deepEqual(source, original);
  assert.deepEqual(stripped, baseline.form);
  for (const key of ["workflow", "scripts", "formRules"]) assert.deepEqual(draft[key], baseline[key], key);
  assert.deepEqual(draft.migrationPolicyAudit.fixedFields.map(f => f.key).sort(), [...ids].sort());
  assert.deepEqual(draft.migrationPolicyAudit.changedActionIds, []);
  const permission = (node, id) => draft.workflow.nodes.find(n => n.id === node).dataAuthority.fields[id];
  for (const id of ids) assert.deepEqual([permission("N2", id).visible, permission("N2", id).editable], [true, false]);
  assert.equal(permission("N3", "fd_leader").editable, true);
  assert.equal(permission("N3", "fd_supervisor").editable, false);
  assert.equal(permission("N4", "fd_leader").visible, false);
  assert.equal(permission("N4", "fd_supervisor").editable, true);
});

it("requires exact typed decisions and refuses the purchase field without source readonly access", () => {
  const x = approved(), decision = x.source.migrationPolicies.decisions[0];
  assert.equal(validateRadioReadOnlyPresentationDecisions([decision]).ok, true);
  for (const bad of [null, [], [{ ...decision, extra: true }], [{ ...decision, fields: [decision.fields[0], decision.fields[0]] }],
    [{ ...decision, fields: [{ ...decision.fields[0], sourceFactDigest: "stale" }] }]]) {
    assert.equal(validateRadioReadOnlyPresentationDecisions(bad).ok, false);
  }
  assert.throws(() => approved(cleanSourceFile(directory), ["fd_purchase"]), /readonly access/);
  for (const fields of [null, {}, "field", [null]]) {
    const malformed = structuredClone(x.draft); malformed.migrationPolicies.decisions[0].fields = fields;
    assert.ok(radioReadOnlyPresentationDslDiagnostics(malformed).length > 0);
  }
});

for (const [name, edit] of [
  ["dynamic option source", t => { t.fdDisplayJsp = t.fdDisplayJsp.replace('<xform:radio property="extendDataFormInfo.value(fd_leader)"', '<xform:radio optionSource="api" property="extendDataFormInfo.value(fd_leader)"'); }],
  ["duplicate renderer", t => { t.fdDisplayJsp += '<xform:radio property="extendDataFormInfo.value(fd_leader)"><xform:simpleDataSource value="A">Agree</xform:simpleDataSource></xform:radio>'; }],
  ["plain-name alternate renderer", t => { t.fdDisplayJsp += '<xform:xtext name="fd_leader"/>'; }],
  ["duplicate designer input", t => { t.fdDesignerHtml += '<input id="fd_leader" type="radio" value="A"/>'; }],
  ["conflicting binding", t => { t.fdDisplayJsp = t.fdDisplayJsp.replace('property="extendDataFormInfo.value(fd_leader)"', 'name="extendDataFormInfo.value(fd_purchase)" property="extendDataFormInfo.value(fd_leader)"'); }],
  ["readonly label branch", t => { t.fdDisplayJsp = t.fdDisplayJsp.replace(/<xform:radio property="extendDataFormInfo.value\(fd_leader\)"[\s\S]*?<\/xform:radio>/, value => '<xform:editShow>' + value + '</xform:editShow><xform:viewShow><xform:xtext property="extendDataFormInfo.value(fd_leader)"/></xform:viewShow>'); }],
  ["runtime rights conflict", t => { t.fdDisplayJsp = t.fdDisplayJsp.replace('mode_N2="view"', 'mode_N2="edit"'); }],
  ["dynamic option mutation", t => { t.fdDisplayJsp += '<script>document.querySelector("input").remove();</script>'; }],
  ["unknown effect", t => { t.fdDesignerHtml += '<div fd_type="jsp" fd_values=\'{id:"fd_unknown"}\'><script>unknownEffect();</script></div>'; t.fdDisplayJsp += '<script>unknownEffect();</script>'; }]
]) it(`refuses an unproved source presentation domain: ${name}`, () => {
  const source = changedSource(edit), fact = source.form.controls.find(f => f.id === "fd_leader").sourceProps.radioReadOnlySourceFact;
  assert.equal(fact.status, "unproven", JSON.stringify(fact.reasons));
  assert.throws(() => approved(source), /verified current main radio/);
});

it("binds approvals to the original complete source digest and current field facts", () => {
  const x = approved(), raw = cleanSourceFile(directory);
  const changed = structuredClone(x.source.migrationPolicies); changed.decisions[0].fields[0].sourceFactDigest = sha256Digest("stale");
  assert.throws(() => draftSourceDraft(attachMigrationPolicies(raw, changed, scope)), /fact changed/);
  const altered = changedSource(t => { t.fdName += " changed"; });
  assert.throws(() => attachMigrationPolicies(altered, x.source.migrationPolicies, scope), /Source Draft digest/);
});

for (const [name, edit] of [
  ["radio alias option.value write", t => {
    const code = "Com_AddEventListener(window,'load',function(){var x=GetXFormFieldById('fd_leader')[0];x.value='X';});";
    t.fdDesignerHtml += '<div fd_type="jsp" fd_values=\'{id:"fd_option_write"}\'><script>' + code + '</script></div>';
    t.fdDisplayJsp += '<script>' + code + '</script>';
  }],
  ["root-table mouse handler", t => { t.fdDisplayJsp = t.fdDisplayJsp.replace('<TABLE ', '<TABLE onmouseover="document.querySelectorAll(\'input[type=radio]\').forEach(function(e){e.remove()})" '); }],
  ["image error handler", t => { t.fdDisplayJsp += '<img src="invalid" onerror="document.querySelector(\'input\').remove()"/>'; }],
  ["designer event handler", t => { t.fdDesignerHtml = t.fdDesignerHtml.replace('<TABLE ', '<TABLE onmouseover="unknownEffect()" '); }],
  ["dynamic alternate binding", t => { t.fdDisplayJsp += '<xform:xtext property="${extendDataFormInfo.value(fd_leader)}"/>'; }],
  ["checked input", t => { t.fdDesignerHtml = t.fdDesignerHtml.replace('id="fd_leader" type="radio" value="A"', 'id="fd_leader" type="radio" value="A" checked="checked"'); }],
  ["nonempty designer default", t => { t.fdDesignerHtml = t.fdDesignerHtml.replace(/(id:"fd_leader"[^}]*?)defaultValue:""/, '$1defaultValue:"A"'); }],
  ["nonempty metadata default", t => { t.fdMetadataXml = t.fdMetadataXml.replace('name="fd_leader" ', 'name="fd_leader" defaultValue="A" '); }]
]) it(`closes the reviewed empty/static profile gap: ${name}`, () => {
  const source = changedSource(edit), f = source.form.controls.find(f => f.id === "fd_leader"), fact = f.sourceProps.radioReadOnlySourceFact;
  assert.equal(fact.status, "unproven", JSON.stringify(fact));
  assert.throws(() => approved(source), /verified current main radio/);
  const policy = { version: 1, sourceDraftSha256: migrationPolicySourceDigest(source), scope,
    authorization: { actor: "hypothetical-fixture-only", evidenceSha256: sha256Digest("Fixture intent cannot prove source structure") },
    decisions: [{ kind: "source-radio-readonly-options", fields: [{ sourceRef: f.sourceRef, sourceFactDigest: fact.digest }] }] };
  const attached = attachMigrationPolicies(source, policy, scope);
  assert.throws(() => draftSourceDraft(attached), /verified current main radio/);
});

for (const [name, text] of [
  ["comment", '<!-- <img onerror="unknownEffect()"/><xform:xtext property="${extendDataFormInfo.value(fd_leader)}"/> -->'],
  ["inert attribute", '<span title="onmouseover=unknownEffect()">Unrelated caption</span>']
]) it(`keeps inert event-like source text outside the executable domain: ${name}`, () => {
  const source = changedSource(t => { t.fdDesignerHtml += text; t.fdDisplayJsp += text; });
  assert.equal(source.form.controls.find(f => f.id === "fd_leader").sourceProps.radioReadOnlySourceFact.status, "verified");
  const { source: authorized, draft } = approved(source);
  const trusted = createTrustedMigrationDsl(authorized, draft, { externalAgentReviewed: true, reviewerName: "fixture", sourceDraftDigest: sha256Digest(authorized) });
  assert.equal(checkTrust(authorized, trusted).ok, true);
  assert.equal(buildDryRunPlan(trusted).ok, true);
});

const htmlBackslash = String.fromCharCode(92);
const quoteVariants = [
  ["HTML backslash before image title quote", '<img title="x' + htmlBackslash + '" src="invalid" onerror="document.querySelector(\'input\').remove()"/>'],
  ["HTML backslash before span title quote", '<span title="x' + htmlBackslash + '"><xform:xtext property="${extendDataFormInfo.value(fd_leader)}"/></span>'],
  ["executable javascript link", '<a href="javascript:document.querySelectorAll(\'input[type=radio]\').forEach(function(e){e.remove()})">action</a>'],
  ["unconsumed tag fragment", '<img title="unterminated'],
  ["unresolved executable URI entity", '<a href="javascript&colon;document.querySelector(\'input\').remove()">action</a>']
];
for (const [name, html] of quoteVariants) it(`closes the final HTML effect domain gap: ${name}`, () => {
  if (name.startsWith("HTML backslash")) assert.equal([...html].filter(c => c.charCodeAt(0) === 92).length, 1);
  const source = changedSource(t => { t.fdDisplayJsp += html; }), f = source.form.controls.find(f => f.id === "fd_leader"), fact = f.sourceProps.radioReadOnlySourceFact;
  assert.equal(fact.status, "unproven", JSON.stringify({ html, fact }));
  assert.throws(() => approved(source), /verified current main radio/);
  const attached = attachMigrationPolicies(source, { version: 1, sourceDraftSha256: migrationPolicySourceDigest(source), scope,
    authorization: { actor: "hypothetical-fixture-only", evidenceSha256: sha256Digest("Fixture intent cannot bypass HTML effects") },
    decisions: [{ kind: "source-radio-readonly-options", fields: [{ sourceRef: f.sourceRef, sourceFactDigest: fact.digest }] }] });
  assert.throws(() => draftSourceDraft(attached), /verified current main radio/);
});

it("rejects an HTML end-bang comment before the following active image", () => {
  const html = '<!-- inert --!><img src="invalid" onerror="document.querySelector(\'input\').remove()"><!-- tail -->';
  const source = changedSource(t => { t.fdDisplayJsp += html; }), f = source.form.controls.find(f => f.id === "fd_leader");
  assert.equal(f.sourceProps.radioReadOnlySourceFact.status, "unproven");
  assert.throws(() => approved(source), /verified current main radio/);
  const policy = { version: 1, sourceDraftSha256: migrationPolicySourceDigest(source), scope,
    authorization: { actor: "hypothetical-fixture-only", evidenceSha256: sha256Digest("Comment intent cannot bypass an effect") },
    decisions: [{ kind: "source-radio-readonly-options", fields: [{ sourceRef: f.sourceRef, sourceFactDigest: f.sourceProps.radioReadOnlySourceFact.digest }] }] };
  assert.throws(() => draftSourceDraft(attachMigrationPolicies(source, policy)), /verified current main radio/);
});

for (const [name, html] of [
  ["existing supported JSP header", '<%@ page language="java" contentType="text/html; charset=UTF-8"%><%@ include file="/resource/jsp/common.jsp"%>'],
  ["existing layered entity document link", '<a href="//docs.example.invalid/item?x=1&amp;amp;id=fixture">Document</a>'],
  ["ordinary https", '<a href="https://docs.example.invalid/path?q=javascript:void(0)">Document</a>'],
  ["fragment", '<a href="#fixture">Jump</a>'],
  ["proved pure void", '<a href="javascript:void(0)">No action</a>']
]) it(`retains proved passive HTML URI or header syntax: ${name}`, () => {
  const source = changedSource(t => { t.fdDisplayJsp = html + t.fdDisplayJsp; });
  const { source: authorized, draft } = approved(source);
  const trusted = createTrustedMigrationDsl(authorized, draft, { externalAgentReviewed: true, reviewerName: "fixture", sourceDraftDigest: sha256Digest(authorized) });
  assert.equal(checkTrust(authorized, trusted).ok, true);
  assert.equal(buildDryRunPlan(trusted).ok, true);
});

it("keeps proved non-radio auxiliary value writes in the public profile/trust/dry-run path", () => {
  const source = changedSource(t => {
    const aux = '<div fd_type="inputText" fd_values=\'{id:"fd_aux",label:"Auxiliary",dataType:"String",canShow:"true"}\'><input id="fd_aux" type="text"/></div>';
    t.fdDesignerHtml = t.fdDesignerHtml.replace(/<\/TD><\/TR><\/TBODY><\/TABLE>$/, aux + '</TD></TR></TBODY></TABLE>');
    t.fdMetadataXml = t.fdMetadataXml.replace('</metadata>', '<extendSimpleProperty name="fd_aux" label="Auxiliary" type="String"/></metadata>');
    t.fdDisplayJsp = t.fdDisplayJsp.replace(/<\/TD><\/TR><\/TBODY><\/TABLE>$/, '<xform:xtext property="extendDataFormInfo.value(fd_aux)"/></TD></TR></TBODY></TABLE>');
    const code = "Com_AddEventListener(window,'load',function(){var x=GetXFormFieldById('fd_aux')[0];x.value='X';});";
    t.fdDesignerHtml += '<div fd_type="jsp" fd_values=\'{id:"fd_aux_effect"}\'><script>' + code + '</script></div>';
    t.fdDisplayJsp += '<script>' + code + '</script>';
  });
  const fact = source.form.controls.find(f => f.id === "fd_leader").sourceProps.radioReadOnlySourceFact;
  assert.equal(fact.status, "verified", JSON.stringify({ reasons: fact.reasons, scriptDomain: fact.scriptDomain, types: [...source.form.controls, ...source.form.dataFields].map(f => [f.id, f.sourceType]) }));
  const { source: authorized, draft } = approved(source);
  const trusted = createTrustedMigrationDsl(authorized, draft, { externalAgentReviewed: true, reviewerName: "fixture", sourceDraftDigest: sha256Digest(authorized) });
  assert.equal(checkTrust(authorized, trusted).ok, true);
  assert.equal(buildDryRunPlan(trusted).ok, true);
});

it("still succeeds after arbitrary field renaming", () => {
  const rename = id => `fd_renamed_${id.slice(3)}`;
  const source = changedSource(t => { for (const key of ["fdDesignerHtml", "fdDisplayJsp", "fdMetadataXml"]) for (const id of ["fd_purchase", ...ids]) t[key] = t[key].replaceAll(id, rename(id)); });
  const { draft } = approved(source, ids.map(rename));
  assert.equal(prepareSample(draft).verify(prepareSample(draft).update).ok, true);
});

for (const [name, id, edit] of [
  ["missing property", "fd_leader", p => { delete p.showContent; }],
  ["unsupported explicit label token", "fd_leader", p => { p.showContent = "selectedItem"; }],
  ["desktop override", "fd_leader", p => { p.desktop.showContent = "selectedItem"; }],
  ["mobile override", "fd_leader", p => { p.mobile.showContent = "selectedItem"; }],
  ["unapproved field expansion", "fd_purchase", p => { p.showContent = "allItem"; }]
]) it(`independently rejects native readback ${name}`, () => {
  const prepared = prepareSample(approved().draft), changed = structuredClone(prepared.update);
  corruptNative(changed, id, edit);
  const checked = prepared.verify(changed);
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some(d => String(d.invariantKey).includes("nativeRadioReadOnlyPresentation")), JSON.stringify(checked.diagnostics));
});

for (const [scene, id, showContent] of [["desktop", "fd_leader", "selectedItem"], ["mobile", "fd_leader", "selectedItem"], ["mobile", "fd_purchase", "allItem"]]) {
  it(`rejects a ${scene} view-style presentation override for ${id}`, () => {
    const prepared = prepareSample(approved().draft), changed = structuredClone(prepared.update), config = xformConfig(changed);
    const view = JSON.parse(config.viewModel[0].fdConfig);
    view.controlStyle[id] ||= {}; view.controlStyle[id][scene] ||= {};
    view.controlStyle[id][scene].showContent = showContent;
    config.viewModel[0].fdConfig = JSON.stringify(view);
    changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    const checked = prepared.verify(changed);
    assert.equal(checked.ok, false);
    assert.ok(checked.diagnostics.some(d => String(d.invariantKey).includes("nativeRadioReadOnlyPresentation")));
  });
}

for (const value of [true, {}, [], 123, "typo", null, "selectedItem"]) it(`rejects an unproved explicit native selected-label value: ${JSON.stringify(value)}`, () => {
  const prepared = prepareSample(approved().draft), changed = structuredClone(prepared.update);
  corruptNative(changed, "fd_purchase", p => { p.showContent = value; });
  const checked = prepared.verify(changed);
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some(d => String(d.invariantKey).includes("nativeRadioReadOnlyPresentation")));
});

for (const scene of ["desktop", "mobile"]) for (const carrier of ["platform", "view-style"]) it(`rejects explicit null in the unapproved ${scene} ${carrier} override`, () => {
  const prepared = prepareSample(approved().draft), changed = structuredClone(prepared.update);
  if (carrier === "platform") corruptNative(changed, "fd_purchase", p => { p[scene].showContent = null; });
  else {
    const config = xformConfig(changed), view = JSON.parse(config.viewModel[0].fdConfig);
    view.controlStyle.fd_purchase ||= {}; view.controlStyle.fd_purchase[scene] ||= {};
    view.controlStyle.fd_purchase[scene].showContent = null;
    config.viewModel[0].fdConfig = JSON.stringify(view); changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  }
  const checked = prepared.verify(changed);
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some(d => String(d.invariantKey).includes("nativeRadioReadOnlyPresentation")));
});

it("runs the public review/trust/dry-run/fake-create/readback/record path and blocks policy or protected-state tampering before I/O", async () => withNetworkGuard(async () => {
  const { source, draft } = approved();
  const reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.report?.diagnostics));
  assert.equal(checkTrust(source, reviewed.dsl).ok, true);
  assert.equal(buildDryRunPlan(reviewed.dsl).ok, true);
  const options = { ...scope, confirmWrite: true, credentials: { username: "fixture", encryptedPassword: "fixture" } };
  const client = new FakeNewoaAdapter("persist"), result = await executeDsl(reviewed.dsl, { ...options, client });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.readback.invariantVersion, 42);
  assert.equal(result.transferRecord.status, "recorded");
  for (const mutate of [
    d => { delete d.migrationPolicies; delete d.migrationPolicyAudit; },
    d => { field(d, "fd_leader").props.options[0].value = "X"; },
    d => { field(d, "fd_leader").props.defaultValue = { kind: "literal", value: "A" }; },
    d => { field(d, "fd_leader").props.readOnly = true; },
    d => { field(d, "fd_leader").props.hiddenLabel = false; },
    d => { field(d, "fd_leader").title = "Changed"; },
    d => { d.workflow.nodes.find(n => n.id === "N2").dataAuthority.fields.fd_leader.visible = false; },
    d => { d.workflow.edges.pop(); },
    d => { d.scripts = { javascript: "unknownEffect();", actions: [] }; },
    d => { field(d, "fd_leader").props.required = false; },
    d => { field(d, "fd_leader").props.options[0].checked = true; },
    d => { field(d, "fd_leader").sourceProps.radioReadOnlySourceFact.sourceHashes.fdDisplayJsp = sha256Digest("forged"); }
  ]) {
    const changed = structuredClone(reviewed.dsl); mutate(changed);
    assert.equal(checkTrust(source, changed).ok, false);
    const blockedClient = new FakeNewoaAdapter("persist"), blocked = await executeDsl(changed, { ...options, client: blockedClient });
    assert.equal(blocked.ok, false, JSON.stringify(blocked.diagnostics));
    if (!changed.migrationPolicies) assert.ok(blocked.diagnostics.some(d => d.code === "dsl.migration_policy_envelope_required"));
    assert.deepEqual(blockedClient.transcript(), []);
  }
  const patch = applyEvidenceBackedPatches(draft, [{ op: "replace", path: "/form/fields/1/title", value: "Changed", sourceRefs: [source.form.controls[1].sourceRef],
    evidence: ["Original source-backed title"], confidence: 0.95, rationale: "Attempt to change a policy-owned field" }], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(patch.ok, false);
  assert.ok(patch.diagnostics.some(d => d.code === "agent.patch.policy_owned_target"), JSON.stringify(patch.diagnostics));
  const mismatch = new FakeNewoaAdapter("persist"), wrong = await executeDsl(reviewed.dsl, { ...options, baseUrl: "https://wrong.example.invalid", client: mismatch });
  assert.equal(wrong.ok, false); assert.deepEqual(mismatch.transcript(), []);
}));

// Execute the unchanged captured native component, observing its actual React
// tree. Only external hooks/services/core primitives are inert; no render branch
// is rewritten or reproduced in the test.
function nativeRadio(scene, controlProps, value, showStatus) {
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: "fragment",
    useState: init => [typeof init === "function" ? init() : init, () => {}], useMemo: cb => cb(), useCallback: cb => cb,
    useRef: current => ({ current }), useEffect() {}, useImperativeHandle() {} };
  const Radio = Object.assign(() => {}, { Group: () => {} });
  const base = { Http: { build: () => ({}) }, SceneShowRules: { NotShowControlTip: [] }, getShowStatus: x => x,
    formatI18nOptions: x => x, transformValueForRuleOption: x => x, useGangedFields: () => ({}), useCommonForRuleFormula() {},
    useOptionsForRuleFormula() {}, useOptionsForJs() {}, getUITestDataTidPrefix: () => "fixture" };
  const dependencies = { react, "@elem/xform-base": base, "@lui/core": { Radio }, "@mui/core": { Radio },
    "@elem/xform-headless": () => {}, "@elem/xform-view": () => {}, "@ekp-infra/render": {},
    "@ekp-infra/common": { Api: { build: () => () => {} }, Module: { getComponent: () => {} } },
    "@ekp-runtime/utils": { appendTestAttrWithoutCheck: () => ({}), appendTestAttr: () => ({}) } };
  const name = scene === "mobile" ? "xform-m-radio.js" : "xform-radio.js", root = "tests/fixtures/executor/persistence/choice-other-wrap/";
  const source = readFileSync(root + name, "utf8"), provenance = JSON.parse(readFileSync(root + "provenance.json", "utf8"));
  assert.equal(createHash("sha256").update(source).digest("hex"), provenance.files[name].sha256);
  const exports = {}, define = (_id, deps, factory) => factory(...deps.map(dep => dep === "exports" ? exports : dependencies[dep]));
  define.amd = true;
  runInNewContext(source, { define, mk: { getI18nInfo: x => x } }, { timeout: 1000 });
  const component = exports.default;
  const tree = component({ ...component.defaultProps, ...controlProps, ...controlProps[scene], value, showStatus, editable: true, scene: "Form", currentStatus: "runtime" });
  const nodes = x => Array.isArray(x) ? x.flatMap(nodes) : x && typeof x === "object" && "type" in x ? [x, ...nodes(x.children)] : [];
  return { radios: nodes(tree).filter(n => n.type === Radio), groups: nodes(tree).filter(n => n.type === Radio.Group), tree };
}
for (const scene of ["desktop", "mobile"]) it(`replays actual native ${scene} readonly empty/A/B and edit branches without creating a default`, () => {
  const prepared = prepareSample(approved().draft), props = nativeProps(prepared.update, "fd_leader");
  for (const value of [undefined, "", "A", "B"]) {
    const readonly = nativeRadio(scene, props, value, "readOnly");
    assert.equal(readonly.radios.length, 2);
    assert.deepEqual(readonly.radios.map(n => n.props.value), ["A", "B"]);
    const readonlyProp = scene === "mobile" ? "readOnly" : "readonly";
    assert.ok(readonly.radios.every(n => n.props[readonlyProp] === true));
    assert.equal(readonly.groups.length, 1);
    assert.equal(readonly.groups[0].props.value || "", value || "");
    const noPolicy = { ...props }; delete noPolicy.showContent;
    assert.equal(nativeRadio(scene, noPolicy, value, "readOnly").radios.length, 0);
    const edit = nativeRadio(scene, props, value, "edit");
    assert.equal(edit.radios.length, 2); assert.ok(edit.radios.every(n => n.props[readonlyProp] === false));
    assert.equal(edit.groups[0].props.value || "", value || "");
  }
});
