import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { approvedRemoteSelectorSourceFacts, applyApprovedRemotePolicies, validateApprovedRemoteDecisions } from "../../src/translator/approved-remote-policies.js";
import { sha256Digest } from "../../src/agent-review/digest.js";
import { executeDsl } from "../../src/executor/execute.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const file = "tests/fixtures/route-validation/approved-remote-policies/route-approved-remote_SysFormTemplate.xml";
const boundFields = source => [...source.form.controls, ...source.form.dataFields, ...source.form.detailTables.flatMap(table => table.columns)];
function input() {
  const raw = fs.readFileSync(file, "utf8"), template = parseSysFormTemplateXml(raw), source = cleanSourceFile(file), facts = approvedRemoteSelectorSourceFacts(template);
  for (const field of boundFields(source)) {
    const contract = field.sourceProps?.remoteSelectorSourceContract;
    if (contract) field.sourceProps.approvedRemoteSelectorSourceFact = facts[contract.tableId ? contract.tableId + "." + field.id : field.id];
  }
  const draft = draftSourceDraft(source);
  const decisions = draft.form.fields.flatMap(field => field.type === "detailTable" ? field.columns : [field]).filter(field => field.sourceProps?.remoteSelectorSourceContract).map(field => ({
    id: "approved-" + field.id, kind: "native-tic-rest-selector", sourceRef: field.sourceRef,
    contractDigest: sha256Digest(field.sourceProps.remoteSelectorSourceContract), runtimeFactDigest: field.sourceProps.approvedRemoteSelectorSourceFact.digest,
    wireEvidenceSha256:"sha256:"+"3".repeat(64), request:{searchParameter:"q",inputParameters:field.sourceProps.remoteSelectorSourceContract.inputMappings.map(mapping=>({sourceParameter:mapping.parameterName,targetParameter:mapping.parameterName}))}, scopeOrigin: "https://qas.example.invalid", server: { fdId: "fixture_resource", code: "fixture_lookup", semanticDigest: "sha256:" + "1".repeat(64), connectionId:"fixture_connection", connectionSemanticDigest:"sha256:"+"4".repeat(64), callerIds: ["fixture_caller"], readOnlyVerified: true, readOnlyEvidenceSha256: "sha256:" + "2".repeat(64) },
    response: { emptySelection:"clear-bound-values", rowsPath: ["rows"], valueColumn: "id", labelColumn: "name", columns: [{ name: "id", title: "Code", type: "String" }, { name: "name", title: "Name", type: "String" }, { name: "description", title: "Description", type: "String" }] }
  }));
  return { raw, source, draft, template, facts, decisions };
}

it("requires an exact private-free typed server binding, explicit ACL and read-only evidence", () => {
  const { decisions } = input(); assert.equal(decisions.length, 2); assert.equal(validateApprovedRemoteDecisions(decisions).ok, true);
  for (const change of [
    d => { d.server.callerIds = []; }, d => { d.server.readOnlyVerified = false; }, d => { d.server.url = "https://forbidden.invalid"; },
    d => { d.response.rowsPath = ["__proto__"]; }, d => { d.response.columns.push({ name: "__lookupKey", title: "bad", type: "String" }); },
    d => { d.response.columns[0].javascript = "sideEffect()"; }, d => { d.runtimeFactDigest = "wrong"; }
  ]) { const decision = structuredClone(decisions[0]); change(decision); assert.equal(validateApprovedRemoteDecisions([decision]).ok, false); }
});

it("binds primary-hidden/readonly-display roles to real tags and rejects duplicates, wrong roles and missing String metadata", () => {
  const { template, facts } = input(); assert.deepEqual(Object.keys(facts), ["fd_project", "rows.fd_code"]);
  for (const mutate of [
    t => { t.fdDisplayJsp += '<input name="extendDataFormInfo.value(fd_project)"/>'; },
    t => { t.fdDisplayJsp = t.fdDisplayJsp.replace('showStatus="noShow"', 'showStatus="edit"'); },
    t => { t.fdDisplayJsp = t.fdDisplayJsp.replace("readOnly='readOnly'", "readOnly='false'"); },
    t => { t.fdDisplayJsp = t.fdDisplayJsp.replace('Dialog_List(false', 'Dialog_List(true'); },
    t => { t.fdMetadataXml = t.fdMetadataXml.replace('name="fd_project_name" type="String"', 'name="fd_project_name" type="Number"'); }
  ]) { const changed = structuredClone(template); mutate(changed); assert.equal(approvedRemoteSelectorSourceFacts(changed).fd_project, undefined); }
  const scriptText = structuredClone(template); scriptText.fdDisplayJsp += '<script>var text = "<input name=\'extendDataFormInfo.value(fd_project)\'/>";</script>';
  assert.ok(approvedRemoteSelectorSourceFacts(scriptText).fd_project);
});

it("preserves original source/files, retains all fields and outputs, restores an actually exported main display binding and leaves no-policy unchanged", () => {
  const { raw, source, draft, decisions } = input(), original = JSON.stringify(source), beforeDraft = JSON.stringify(draft);
  assert.deepEqual(applyApprovedRemotePolicies(source, draft, []).draft, draft);
  const result = applyApprovedRemotePolicies(source, draft, decisions);
  assert.equal(JSON.stringify(source), original); assert.equal(JSON.stringify(draft), beforeDraft); assert.equal(fs.readFileSync(file, "utf8"), raw);
  assert.equal(result.changedActionIds.length, 2); assert.equal(result.audits.length, 2);
  assert.ok(result.draft.form.fields.find(field => field.id === "fd_project").dataOnly);
  assert.equal(result.draft.form.fields.find(field => field.id === "fd_project_name").props.readOnly, true);
  const table = result.draft.form.fields.find(field => field.id === "rows");
  assert.equal(table.columns.find(field => field.id === "fd_code").dataOnly, true); assert.equal(table.columns.find(field => field.id === "fd_other").title, "Other");
  for (const audit of result.audits) {
    assert.equal(audit.queryOnMount, false); assert.equal(audit.outputMappings.length, 3); assert.equal(audit.sourceRuntimeBindings.length, 2);
    const action = result.draft.scripts.actions.find(action => action.id === audit.actionId);
    assert.match(action.function, /function onClick\(event, rowNum, parentRowNum\)/); assert.equal(action.function.includes("upstream.example.invalid"), false);
    assert.equal(action.sourceRefs[0], audit.sourceScript.sourceRef); assert.equal(result.draft.form.fields.flatMap(field => field.type === "detailTable" ? field.columns : [field]).find(field => field.id === action.controlId).sourceRef, undefined);
  }
});

it("runs native modal/table callbacks: no preload, query parameters, all main outputs, cancellation and invalid/error response with zero writes", () => {
  const { source, draft, decisions } = input(), result = applyApprovedRemotePolicies(source, draft, decisions);
  const main = result.draft.scripts.actions.find(action => result.changedActionIds.includes(action.id) && !action.tableId);
  const runtime = harness(main);
  assert.equal(runtime.requests.length, 0); assert.deepEqual(runtime.writes, []);
  runtime.search("wind"); assert.equal(runtime.requests.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(runtime.requests[0].request)), { interfaceCode: "fixture_lookup", param: { q: "wind" } });
  runtime.reply(0, null, { rows: [{ id: "P1", name: "Name one", description: "Region one" }] });
  runtime.choose(0); runtime.confirm();
  assert.deepEqual(runtime.writes, [["main", "fd_project", "P1"], ["main", "fd_project_name", "Name one"], ["main", "fd_region", "Region one"]]);
  for (const payload of [{ error: true }, { rows: [{ id: "P", name: "N" }] }, { rows: [{ id: "P", name: "N", description: {} }] }]) {
    const failed = harness(main); failed.search("x"); failed.reply(0, null, payload); failed.confirm(); assert.deepEqual(failed.writes, []);
  }
  const cancelled = harness(main); cancelled.search("x"); cancelled.cancel(); cancelled.reply(0, null, { rows: [{ id: "P", name: "N", description: "D" }] }); cancelled.confirm(); assert.deepEqual(cancelled.writes, []);
  const transportError = harness(main); transportError.search("x"); transportError.reply(0, new Error("fixture error")); transportError.confirm(); assert.deepEqual(transportError.writes, []);
});

it("keeps current-row identity across reordering and writes the complete patch once, with deleted/duplicate/unknown-parent rows blocked", () => {
  const { source, draft, decisions } = input(), result = applyApprovedRemotePolicies(source, draft, decisions), action = result.draft.scripts.actions.find(action => result.changedActionIds.includes(action.id) && action.tableId);
  const data = { fd_project: "main-project", rows: [{ key: "row-a", fd_other: "A" }, { key: "row-b", fd_other: "B" }] };
  const runtime = harness(action, structuredClone(data), 1); runtime.search("code");
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.requests[0].request.param)), { q: "code", project: "main-project" });
  runtime.reply(0, null, { rows: [{ id: "C", name: "Name C", description: null }] }); runtime.choose(0); runtime.data.rows.reverse(); runtime.confirm();
  assert.deepEqual(runtime.writes, [["row", "rows", 0, { fd_code: "C", fd_code_name: "Name C", fd_description: "" }]]);
  assert.equal(runtime.data.rows[1].fd_other, "A"); assert.equal(runtime.data.rows[0].fd_other, "B");
  for (const mutation of [data => data.rows.splice(1, 1), data => data.rows.push({ key: "row-b" })]) {
    const invalid = harness(action, structuredClone(data), 1); invalid.search("x"); invalid.reply(0, null, { rows: [{ id: "C", name: "N", description: "D" }] }); invalid.choose(0); mutation(invalid.data); invalid.confirm(); assert.deepEqual(invalid.writes, []);
  }
  const nested = harness(action, structuredClone(data), 1, 0); assert.equal(nested.opened(), false); assert.equal(nested.requests.length, 0); assert.deepEqual(nested.writes, []);
});

it("ignores a stale query result and stale selection, rejects altered facts/binding/missing outputs, and no-policy execution sends no fake request", async () => withNetworkGuard(async () => {
  const { source, draft, decisions } = input(), result = applyApprovedRemotePolicies(source, draft, decisions), action = result.draft.scripts.actions.find(action => result.changedActionIds.includes(action.id) && !action.tableId);
  const runtime = harness(action); runtime.search("old"); runtime.search("new"); runtime.reply(0, null, { rows: [{ id: "old", name: "old", description: "old" }] }); assert.equal(runtime.table().dataSource.length, 0);
  runtime.reply(1, null, { rows: [{ id: "new", name: "new", description: "new" }] }); runtime.choose(0); runtime.confirm(); assert.equal(runtime.writes[0][2], "new");
  for (const mutation of [
    d => { d.form.fields.find(field => field.id === "fd_project").sourceProps.approvedRemoteSelectorSourceFact.bindings[0].sha256 = "sha256:" + "0".repeat(64); },
    d => { d.form.fields = d.form.fields.filter(field => field.id !== "fd_region"); },
    d => { d.form.fields.push(structuredClone(d.form.fields.find(field => field.id === "fd_project"))); }
  ]) { const changed = structuredClone(draft); mutation(changed); assert.throws(() => applyApprovedRemotePolicies(source, changed, [decisions[0]])); }
  const client = new FakeNewoaAdapter("persist"), executed = await executeDsl(draft, { client, confirmWrite: true, targetCategoryId: "route-category-id", credentials: { username: "fixture", encryptedPassword: "fixture" } });
  assert.equal(executed.ok, false); assert.deepEqual(client.transcript(), []);
}));

function harness(action, data = {}, row = undefined, parent = undefined) {
  const writes = [], requests = [], holder = { state: undefined }, React = { createElement(type, props, ...children) { return { type, props: { ...props, children } }; } }, UI = { Search: "NativeSearch", Table: "NativeTable", Button:"NativeButton" };
  // The exact tableModal body is exercised against native prop-boundary fakes;
  // no browser, real package execution, network or target business call occurs.
  const tableModalText = 'function(e){return(void 0===e?"undefined":e&&"undefined"!=typeof Symbol&&e.constructor===Symbol?"symbol":typeof e)!="object"?(console.error("Params must be object!"),null):i.Modal.info(Object.assign({content:r.createElement("div",{style:{display:"inline-grid",width:"100%"}},[r.createElement(i.Table,Object.assign({style:{border:"none",maxHeight:"500px",overflow:"auto"},scroll:{x:!0,y:!0},pagination:!1},e.table))]),closable:!0,icon:null,width:1152,destroyOnClose:!0,style:{maxHeight:"776px"},okButtonProps:{style:{display:"none"}}},e.modal))}';
  const Modal = { info(config) { holder.state = config; return { update(patch) { Object.assign(holder.state, patch); }, destroy() {} }; } };
  const tableModal = vm.runInNewContext("(" + tableModalText + ")", { i: { ...UI, Modal }, r: React, console });
  const MKXFORM = { tableModal, callTic(request, callback) { requests.push({ request, callback }); }, getValue(id) { return data[id]; }, getControlValue(id, index) { const [table, field] = id.split("."); return data[table]?.[index]?.[field]; },
    setValue(id, value) { writes.push(["main", id, value]); data[id] = value; }, updateRow(id, index, patch) { const plain = JSON.parse(JSON.stringify(patch)); writes.push(["row", id, index, plain]); Object.assign(data[id][index], plain); } };
  vm.runInNewContext(action.function.replace(/\$\{table:([^}]+)\}/g, "$1") + ";onClick(undefined,row,parent);", { window: { react: React, "@lui/core": UI }, MKXFORM, row, parent });
  const findTable = node => { if (!node || typeof node !== "object") return undefined; if (node.type === UI.Table) return node.props; for (const child of node.props?.children || []) { if (Array.isArray(child)) { for (const entry of child) { const found = findTable(entry); if (found) return found; } } else { const found = findTable(child); if (found) return found; } } };
  const table = () => findTable(holder.state?.content);
  return { writes, requests, data, table, opened: () => Boolean(holder.state), search(keyword) { table().title().props.onSearch(keyword); }, reply(index, error, payload) { requests[index].callback(error, payload); }, choose(index) { const record = table().dataSource[index]; table().rowSelection.onChange([record.__lookupKey], [record]); }, confirm() { holder.state?.onOk(); }, cancel() { holder.state?.onCancel(); }, clear() { holder.state?.footer[0].props.onClick(); } };
}

it('explicit clear applies all bound outputs, while empty search, cancellation and late responses never clear existing values',()=>{
 const {source,draft,decisions}=input(),result=applyApprovedRemotePolicies(source,draft,decisions);
 for(const detail of [false,true]){
  const action=result.draft.scripts.actions.find(action=>result.changedActionIds.includes(action.id)&&Boolean(action.tableId)===detail);
  const data=detail?{fd_project:'P',rows:[{key:'stable',fd_code:'old',fd_code_name:'Old',fd_description:'Desc'}]}:{fd_project:'old',fd_project_name:'Old',fd_region:'Desc'};
  const runtime=harness(action,structuredClone(data),detail?0:undefined);runtime.search('empty');runtime.reply(0,null,{rows:[]});assert.deepEqual(runtime.writes,[]);
  runtime.clear();
  assert.deepEqual(runtime.writes,detail?[['row','rows',0,{fd_code:'',fd_code_name:'',fd_description:''}]]:[['main','fd_project',''],['main','fd_project_name',''],['main','fd_region','']]);
  runtime.reply(0,null,{rows:[{id:'late',name:'Late',description:'Late'}]});runtime.confirm();assert.equal(runtime.writes.length,detail?1:3);
  const lost=harness(action,structuredClone(data),detail?0:undefined);if(detail)lost.data.rows=[];else lost.cancel();lost.clear();assert.deepEqual(lost.writes,[]);
 }
});
