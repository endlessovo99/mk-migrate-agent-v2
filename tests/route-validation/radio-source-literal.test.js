import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sourceRadioLayouts } from "../../src/dsl/source-radio-layout.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const load = name => {
  const source = cleanSourceFile(`tests/fixtures/route-validation/radio-source-presentation/literal-qualification/${name}_SysFormTemplate.xml`);
  return { source, draft: draftSourceDraft(source) };
};
const checked = (source, draft) => checkTrust(source, createTrustedMigrationDsl(source, draft, {
  externalAgentReviewed: true, reviewerName: "synthetic radio complete-literal qualification"
}));

it("binds genuine H4 grouping to complete literal source values", () => {
  const { source, draft } = load("canonical"), field = draft.form.fields.find(field => field.id === "fd_h4");
  assert.equal(field.sourceProps.designerRadioLayoutLiteral, true);
  assert.equal(sourceRadioLayouts(draft.form).has(field.sourceRef), true);
  assert.equal(checked(source, draft).ok, true);
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("does not grant or trust comment, duplicate, dynamic or executable source grouping facts", () => {
  for (const name of ["comment-phantom-H", "duplicate-alignment", "dynamic-alignment", "executing-extra-property"]) {
    const { source, draft } = load(name), field = draft.form.fields.find(field => field.id === "fd_h4");
    assert.equal(field.sourceProps.designerValues.alignment, "H", "Retain the legacy parser fact so the regression remains meaningful");
    assert.equal(field.props.options.length, 4);
    assert.equal(sourceRadioLayouts(draft.form).has(field.sourceRef), false, name);
    assert.equal(field.sourceProps.designerRadioLayoutLiteral, false);
    const trusted = checked(source, draft), applied = applyEvidenceBackedPatches(draft, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    for (const result of [trusted, applied]) {
      assert.equal(result.ok, false, name);
      assert.ok(result.diagnostics.some(item => /radio_layout_source_unproven/.test(item.code)), JSON.stringify(result.diagnostics));
    }
    // A pure projection is not an authorized route. It must retain default
    // grouping instead of inventing the unproved source H4 mapping.
    const payload = prepareSample(draft).update;
    const native = xformConfig(payload).dataModel.flatMap(model => model.fdFields || []).find(field => field.fdName === "fd_h4");
    const props = JSON.parse(native.fdAttribute).config.controlProps;
    assert.equal(Object.hasOwn(props, "direction"), false);
    assert.equal(Object.hasOwn(props, "rowCount"), false);
  }
});

it("rejects deleted or forged literal-source evidence in both trust and empty apply", () => {
  for (const [name, mutate] of [
    ["canonical", field => { delete field.sourceProps.designerRadioLayoutLiteral; }],
    ["canonical", field => { field.sourceProps.designerRadioLayoutLiteral = false; }],
    ["comment-phantom-H", field => { field.sourceProps.designerRadioLayoutLiteral = true; }]
  ]) {
    const { source, draft } = load(name), changed = structuredClone(draft);
    mutate(changed.form.fields.find(field => field.id === "fd_h4"));
    assert.equal(checked(source, changed).ok, false);
    assert.equal(applyEvidenceBackedPatches(changed, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) }).ok, false);
  }
});

it("blocks the genuine unproved-source route before any target operation", async () => {
  const result = await runRouteCase("radio-source-literal-unproven-blocks-review");
  assert.equal(result.review.status, "blocked");
  assert.deepEqual(result.transcript, []);
  assert.equal(result.execution, undefined);
});
