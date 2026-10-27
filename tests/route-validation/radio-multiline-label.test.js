import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sourceRadioLayouts } from "../../src/dsl/source-radio-layout.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const load = () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/radio-source-presentation/literal-qualification/multiline-label_SysFormTemplate.xml");
  return { source, draft: draftSourceDraft(source) };
};

it("proves grouping from a complete static multiline label while retaining the stricter width boundary", () => {
  const { source, draft } = load(), field = draft.form.fields.find(field => field.id === "fd_h4");
  assert.equal(field.sourceProps.designerValues.label, "Horizontal\r\nfour");
  assert.equal(field.sourceProps.designerRadioLayoutLiteral, true);
  assert.equal(sourceRadioLayouts(draft.form).has(field.sourceRef), true);
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "synthetic static multiline radio label" });
  assert.equal(checkTrust(source, trusted).ok, true);
  assert.equal(applyEvidenceBackedPatches(draft, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) }).ok, true);
  const items = draft.form.layout.mkTree.flatMap(row => row.children.flatMap(cell => cell.contentFlow?.items || []));
  assert.deepEqual(items.find(item => item.referenceId === "fd_h4").width, { value: 579, unit: "px" }, "Multiline grouping proof does not grant width removal");
  const prepared = prepareSample(draft), native = xformConfig(prepared.update).dataModel.flatMap(model => model.fdFields || []).find(field => field.fdName === "fd_h4");
  const props = JSON.parse(native.fdAttribute).config.controlProps;
  assert.equal(props.direction, "column"); assert.equal(props.rowCount, 4);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("continues to reject candidate label rewriting after multiline grouping is proved", () => {
  const { source, draft } = load(), changed = structuredClone(draft);
  changed.form.fields.find(field => field.id === "fd_h4").sourceProps.designerValues.label = "Horizontal four";
  const trusted = createTrustedMigrationDsl(source, changed, { externalAgentReviewed: true, reviewerName: "synthetic candidate label laundering" });
  assert.equal(checkTrust(source, trusted).ok, false);
  assert.equal(applyEvidenceBackedPatches(changed, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) }).ok, false);
});

it("completes the genuine static multiline-label route through native readback and record", async () => {
  const result = await runRouteCase("radio-static-multiline-label-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.readback.invariantVersion, 43);
  assert.equal(result.execution.transferRecord.status, "recorded");
});
