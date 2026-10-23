import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { parseRootHashMapXmlStringPuts } from "../../src/translator/xml-utils.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeRequiredRuntime } from "../helpers/native-required-runtime.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const fixture = "tests/fixtures/route-validation/jsp-button-rights";
const formName = "route-jsp-button-rights_SysFormTemplate.xml";
const workflowName = "route-jsp-button-rights_LbpmProcessDefinition.xml";
const buttonId = "jsp_fixture_button";
const flags = (field) => field && ({ visible: field.visible, editable: field.editable, required: field.required });

it("inherits the enclosing source right section for a translated JSP button", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.find(field => field.id === buttonId)?.componentId, "xform-button");
  assert.equal(draft.scripts.actions.find(action => action.controlId === buttonId)?.translationStatus, "mapped");
  for (const artifact of [source, draft]) {
    const draftRight = artifact.workflow.nodes.find(node => node.id === "N2").dataAuthority?.fields?.[buttonId];
    assert.deepEqual(flags(draftRight), { visible: false, editable: false, required: false });
    assert.equal(draftRight.sourceMode, "hidden");
    assert.match(draftRight.sourceRef, /button_right\.n2\.jsp_fixture_button$/);
    assert.deepEqual(flags(artifact.workflow.nodes.find(node => node.id === "N72").dataAuthority.fields[buttonId]),
      { visible: true, editable: true, required: false });
  }
  assert.ok(source.issues.some(issue => issue.code === "source.form_right.case_variant_conflict" &&
    issue.evidence.fieldId === buttonId && issue.evidence.selectedNodeId === "n2"));
});

it("passes the paired XML through review, dry-run, fake execution and independent authority readback", async () => withNetworkGuard(async () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const review = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
  assert.equal(review.ok, true, JSON.stringify(review.report));
  assert.equal(buildDryRunPlan(review.dsl).ok, true);
  const client = new FakeNewoaAdapter("persist");
  const result = await executeDsl(review.dsl, { client, confirmWrite: true,
    credentials: { username: "route-test-user", encryptedPassword: "route-test-encrypted-password" },
    targetCategoryId: "route-category-id", now: new Date("2026-07-10T00:00:00.000Z") });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.readback.partitions.workflow, "verified");
  const nodes = result.readback.workflow.nodes;
  assert.deepEqual(nodes.find(node => node.id === "N2").dataAuthority.fields[buttonId],
    { visible: false, editable: false, required: false });
  assert.deepEqual(nodes.find(node => node.id === "N72").dataAuthority.fields[buttonId],
    { visible: true, editable: true, required: false });
  assert.equal(result.transferRecord.status, "recorded");
}));

it("lets captured native auth consume the persisted node permissions without globally changing editShow", () => {
  const prepared = prepareSample(draftSourceDraft(cleanSourceFile(fixture)));
  const observed = prepared.verify(prepared.update);
  assert.equal(observed.ok, true);
  const original = xformConfig(prepared.update), main = original.dataModel.find(model => model.fdType === "main").fdTableName;
  assert.equal(original.auth[0].add[main].fields[buttonId].visible, true,
    "The default editShow add/edit contract must not be globally reinterpreted");
  for (const [nodeId, hidden] of [["N2", true], ["N72", false]]) {
    const config = structuredClone(original);
    const permission = observed.workflow.nodes.find(node => node.id === nodeId).dataAuthority.fields[buttonId];
    // The native useAuth consumer receives this node overlay as its field auth.
    // This does not simulate the server selecting N2 for a real new document.
    config.auth[0].add[main].fields[buttonId] = { ...permission };
    const runtime = nativeRequiredRuntime(config, "add");
    assert.equal(runtime.field(buttonId).labelProps.hidden, hidden);
  }
});

it("rejects persisted workflow permission loss for the generated button", () => {
  const prepared = prepareSample(draftSourceDraft(cleanSourceFile(fixture))), changed = structuredClone(prepared.update);
  const node = changed.mechanisms.lbpmTemplate[0].fdTemplateFormAuths.N2;
  assert.equal(node[buttonId].isShow, false);
  delete node[buttonId];
  assert.equal(prepared.verify(changed).ok, false);
});

it("does not grant a right entry to an unrecognized JSP click fragment", () => variant(xml =>
  xml.replaceAll("onclick=&quot;compileFixtureVoucher()&quot;", "onclick=&quot;unprovenHandler()&quot;"), path => {
  const source = cleanSourceFile(path), draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.some(field => field.id === buttonId), false);
  assert.ok(source.workflow.nodes.every(node => !node.dataAuthority?.fields?.[buttonId]));
}));

it("keeps a translated button outside a right section outside that section's permissions", () => variant(xml =>
  changeDesigner(xml, html => html
    .replace(/(<div fd_type="right"[^>]+>)/, "$1</div>")
    .replace("</div></div>", "</div>")), path => {
  const source = cleanSourceFile(path), draft = draftSourceDraft(source);
  assert.ok(draft.form.fields.some(field => field.id === buttonId));
  assert.ok(source.workflow.nodes.every(node => !node.dataAuthority?.fields?.[buttonId]));
}));

it("does not infer source ownership when the same JSP fragment identity occurs twice", () => variant(xml =>
  changeDesigner(xml, html => {
    const start = html.indexOf(`<div id="${buttonId}"`), end = html.indexOf("\n", start);
    const fragment = html.slice(start, end).replace(/<\/div>$/, ""); // Remove the enclosing right close.
    return html + "\n" + fragment;
  }), path => {
  const source = cleanSourceFile(path), draft = draftSourceDraft(source);
  assert.equal(source.scripts.fragments.filter(fragment => fragment.id === buttonId).length, 2);
  assert.ok(source.workflow.nodes.every(node => !node.dataAuthority?.fields?.[buttonId]));
  assert.equal(checkDraft(draft).ok, false, "Ambiguous duplicate controls must not become executable");
}));

it("binds a different generated control identity without relying on a form or button name", () => variant(xml =>
  xml.replaceAll(buttonId, "generated_another_action"), path => {
  const source = cleanSourceFile(path), draft = draftSourceDraft(source);
  assert.deepEqual(flags(draft.workflow.nodes.find(node => node.id === "N2").dataAuthority.fields.generated_another_action),
    { visible: false, editable: false, required: false });
}));

function changeDesigner(xml, transform) {
  const props = parseRootHashMapXmlStringPuts(xml);
  props.fdDesignerHtml = transform(props.fdDesignerHtml);
  const encode = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
    Object.entries(props).map(([key, value]) => `<void method="put"><string>${encode(key)}</string><string>${encode(value)}</string></void>`).join("") +
    "</object></java>";
}

function variant(transform, inspect) {
  const root = mkdtempSync(join(tmpdir(), "mk-jsp-button-rights-"));
  try {
    const original = readFileSync(join(fixture, formName), "utf8"), changed = transform(original);
    assert.notEqual(changed, original);
    writeFileSync(join(root, formName), changed);
    writeFileSync(join(root, workflowName), readFileSync(join(fixture, workflowName)));
    inspect(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
