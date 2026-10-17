import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { parseRootHashMapXmlStringPuts } from "../../src/translator/xml-utils.js";
import { analyzeOrphanBeforeAnchorWitness, inspectOrphanBeforeAnchorWitness } from "../../src/translator/orphan-before-anchor-witness.js";
import { normalizeAuditedSourceRowOrphans } from "../../src/translator/source-row-orphan-normalization.js";

const fixture = "tests/fixtures/route-validation/orphan-before-anchor-witness/route-orphan-anchor_SysFormTemplate.xml";
function inputs() {
  const xml = readFileSync(fixture, "utf8"), source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  return { xml, source, draft, script: source.scripts.sources[0], rawMarkup: parseRootHashMapXmlStringPuts(xml) };
}
function analyze(script, form, sourceScripts, rawMarkup) { return analyzeOrphanBeforeAnchorWitness(script, form, { sourceScripts, rawMarkup }); }

describe("source-bound orphan-before-anchor point witness", () => {
  it("retains the complete source and anchor and proves only the earlier call point", () => {
    const { source, draft, script, rawMarkup } = inputs(), before = structuredClone(script);
    assert.equal(normalizeAuditedSourceRowOrphans(script, draft.form), undefined, "The whole-source dynamic DOM guard remains unchanged.");
    const witness = analyze(script, draft.form, source.scripts, rawMarkup);
    assert.ok(witness);
    assert.equal(witness.rowCall.rowId, "fd_retired_row");
    assert.ok(witness.rowCall.end < witness.anchor.start);
    assert.equal(witness.anchor.containerId, "documentAnchor");
    assert.deepEqual(witness.rawMarkup.runtimeAnchor.rowMarkers, ["fd_present_row"]);
    assert.deepEqual(witness.reads.map(r => r.fieldId), ["fd_document_url", "fd_category"]);
    assert.match(witness.contracts.anchor, /existing dynamicAnchorAssignment/);
    assert.equal(inspectOrphanBeforeAnchorWitness(witness, script, draft.form, { sourceScripts: source.scripts, rawMarkup }).ok, true);
    assert.deepEqual(script, before);
    assert.match(script.javascript.slice(witness.anchor.start, witness.anchor.end), /innerHTML/);
    assert.match(witness.witnessSha256, /^[a-f0-9]{64}$/);
  });

  it("supports the actual adapter's Legacy fields/dataFields/layout.rows input", () => {
    const { xml, rawMarkup } = inputs(), legacy = translateSysFormTemplateXml(xml);
    assert.ok(legacy.form.layout.rows);
    const source = legacy.scripts.sources[0];
    const witness = analyze(source, legacy.form, legacy.scripts, rawMarkup);
    assert.ok(witness);
    assert.deepEqual(witness.layoutMarkerIds, ["fd_present_row"]);
  });

  it("refuses earlier creation, repeated callbacks, explicit dispatch and impure HTML", () => {
    const { source, draft, script, rawMarkup } = inputs();
    assert.equal(analyze(script, draft.form, { sources: [script, script] }, rawMarkup), undefined);
    const changed = javascript => { const input = { ...script, javascript }; return analyze(input, draft.form, { sources: [input] }, rawMarkup); };
    for (const mutate of [
      text => text.replace('  var category', '  document.createElement("input");\n  var category'),
      text => text + '\nCom_AddEventListener(window,"load",function(){});',
      text => text.replace('  var category', '  window.dispatchEvent(new Event("load"));\n  var category'),
      text => text.replace('查看发票</a>', '查看发票<img src=x></a>'),
      text => text.replace('  document.getElementById', '  audit();\n  document.getElementById'),
      text => text.replace('"<a href=\'"', '"<a onclick=\'run()\' href=\'"'),
      text => text.replace('  common_dom_row_set_show_required_reset("fd_retired_row", true, true, false);\n', '').replace('  var resource', '  common_dom_row_set_show_required_reset("fd_retired_row", true, true, false);\n  var resource')
    ]) {
      const text = mutate(script.javascript);
      assert.notEqual(text, script.javascript, "Negative must change the actual input.");
      assert.equal(changed(text), undefined, text);
    }
    for (const javascript of [
      'document.createElement("input");',
      'window.dispatchEvent(new Event("load"));',
      'window["dispatchEvent"]({type:"load"});',
      'var previous = document; previous.indexOf = previous.write; previous.indexOf("<input>");',
      'var previous = window; previous.indexOf = previous.dispatchEvent; previous.indexOf({type:"load"});',
      'var factory = externalObject; factory.indexOf("<input>");',
      'common_dom_row_set_show_required_reset = function(){};',
      'function GetXFormFieldById(){}',
      'unprovenExternalFactory();',
      'SetXFormFieldValueById("fd_unbound", "x");',
      'var id="fd_"+"retired_row"; SetXFormFieldValueById(id,"x");'
    ]) assert.equal(analyze(script, draft.form, { sources: [script, { id: "other", sourceRef: "source.other", javascript }] }, rawMarkup), undefined);
  });

  it("rejects actual/ambiguous bindings, stale facts, missing raw evidence and forged witnesses", () => {
    const { source, draft, script, rawMarkup } = inputs();
    for (const raw of [
      { ...rawMarkup, fdDisplayJsp: rawMarkup.fdDisplayJsp.replace('<div id="documentAnchor">', '<input id="fd_retired_row"/><div id="documentAnchor">') },
      { ...rawMarkup, fdDisplayJsp: rawMarkup.fdDisplayJsp.replace('<div id="documentAnchor">', '<div id="documentAnchor"></div><div id="documentAnchor">') },
      { ...rawMarkup, fdDisplayJsp: rawMarkup.fdDisplayJsp.replace('<div id="documentAnchor">', '<input id="${runtimeId}"/><div id="documentAnchor">') },
      { ...rawMarkup, fdDisplayJsp: rawMarkup.fdDisplayJsp.replace('<script>', '<script src="/unknown.js"></script><script>') }
    ]) assert.equal(analyze(script, draft.form, source.scripts, raw), undefined);
    const visible = structuredClone(draft.form); visible.layout.mkTree[0].sourceMarkers = ["fd_retired_row"];
    assert.equal(analyze(script, visible, source.scripts, rawMarkup), undefined);
    const stale = { ...script, semanticFacts: { ...script.semanticFacts, rowMarkers: [] } };
    assert.equal(analyze(stale, draft.form, { sources: [stale] }, rawMarkup), undefined);
    assert.equal(analyze(script, draft.form, source.scripts), undefined);
    const witness = analyze(script, draft.form, source.scripts, rawMarkup); witness.anchor.label = "different";
    assert.equal(inspectOrphanBeforeAnchorWitness(witness, script, draft.form, { sourceScripts: source.scripts, rawMarkup }).ok, false);
  });
});

it("runs the new XML witness route through trust/dry-run/fake readback and one receipt", async () => {
  const { runAgentReview } = await import("../../src/agent-review/index.js");
  const { createFakeReviewProvider } = await import("./fake-review-provider.js");
  const { FakeNewoaAdapter } = await import("./fake-newoa-adapter.js");
  const { executeDsl } = await import("../../src/executor/execute.js");
  const { buildDryRunPlan } = await import("../../src/executor/dry-run.js");
  const { withNetworkGuard } = await import("./network-guard.js");
  const { checkTrust } = await import("../../src/dsl/trust.js");
  await withNetworkGuard(async () => {
    const source = cleanSourceFile(fixture), original = structuredClone(source), draft = draftSourceDraft(source);
    assert.deepEqual(source, original);
    assert.ok(source.scripts.sources[0].semanticFacts.orphanBeforeAnchorWitness);
    assert.equal(draft.scripts.actions.length, 1);
    const action = draft.scripts.actions[0];
    assert.equal(action.translationStatus, "mapped");
    assert.equal(action.functionMappings[0].basis, "deterministic-dynamic-hyperlink");
    assert.doesNotMatch(action.function, /\bdocument\s*\.|innerHTML|fd_retired_row/);
    assert.doesNotMatch(action.function, /setFieldAttr\("fd_present_row"/);
    const field = draft.form.fields.find(field => field.componentId === "xform-hyperlinks");
    assert.ok(field);
    const reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed.report?.diagnostics));
    assert.equal(checkTrust(source, reviewed.dsl).ok, true);
    assert.equal(buildDryRunPlan(reviewed.dsl).ok, true);
    // JSONB preserves values and array order, but does not preserve object key order.
    const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;
    const persistedSource = JSON.parse(JSON.stringify(reorder(source)));
    const persistedDsl = JSON.parse(JSON.stringify(reorder(reviewed.dsl)));
    assert.equal(checkTrust(persistedSource, persistedDsl).ok, true);
    assert.deepEqual(draftSourceDraft(persistedSource).scripts.actions.map(action => action.function),
      draft.scripts.actions.map(action => action.function));
    const persistedWitness = persistedSource.scripts.sources[0].semanticFacts.orphanBeforeAnchorWitness;
    assert.equal(inspectOrphanBeforeAnchorWitness(persistedWitness, persistedSource.scripts.sources[0], draft.form,
      { sourceScripts: persistedSource.scripts, rawMarkup: inputs().rawMarkup }).ok, true);
    const client = new FakeNewoaAdapter("persist");
    const report = await executeDsl(persistedDsl, { client, confirmWrite: true, targetCategoryId: "route-category-id",
      credentials: { username: "fixture", encryptedPassword: "fixture-password" }, now: new Date("2026-10-17T00:00:00.000Z"),
      transferRecordIdFactory: () => "route0000000000000000000000000000000" });
    assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
    assert.equal(report.readback.ok, true);
    assert.equal(report.transferRecord.status, "recorded");
    assert.equal(client.transcript().filter(call => call.operation === "add-transfer-record").length, 1);
    const changed = structuredClone(reviewed.dsl);
    changed.scripts.actions[0].function = changed.scripts.actions[0].function.replace("查看发票", "different");
    assert.equal(checkTrust(source, changed).ok, false);
    const forged = structuredClone(reviewed.dsl);
    forged.form.fields.find(field => field.componentId === "xform-hyperlinks").sourceProps.dynamicHyperlinkProjection.destinationRowMarker = "fd_retired_row";
    const trust = checkTrust(source, forged);
    assert.equal(trust.ok, false);
    assert.ok(trust.diagnostics.some(d => d.code === "trust.form.dynamic_hyperlink_projection_source_mismatch"));
  });
});
