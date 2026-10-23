import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeViewSaveRoundTrip } from "../helpers/native-view-save.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { renderNativeDescription, verifyNativeDescriptionSources } from "../helpers/native-description-renderer.js";
import { runRouteCase } from "./run-route-case.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";

const fixture = "tests/fixtures/route-validation/description-presentation/description-presentation_SysFormTemplate.xml";

it("pins the actual native description and text-view components", verifyNativeDescriptionSources);

it("carries heading presentation through review, dry-run, fake execution and readback", async () => {
  const result = await runRouteCase("description-presentation-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.readback.partitions.form, "verified");
  assert.deepEqual(result.dsl.form.fields.find(field => field.id === "heading_primary").props.style,
    { fontWeight: "bold", fontSize: 24, textAlign: "center" });
});

it("preserves source heading centering and 24px type through DSL and native save/readback on both platforms", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const heading = draft.form.fields.find(field => field.id === "heading_primary");
  assert.deepEqual(heading.props.style, { fontWeight: "bold", fontSize: 24, textAlign: "center" });
  const prepared = prepareSample(draft);
  const saved = nativeViewSaveRoundTrip(xformConfig(prepared.update));
  const view = JSON.parse(saved.viewModel[0].fdConfig);
  for (const scene of ["desktop", "mobile"]) {
    assert.equal(view.controlStyle.heading_primary[scene].controlValueStyle.fontSize, 24);
    assert.equal(view.controlStyle.heading_primary[scene].alignDesc, "center");
    const rendered = renderNativeDescription(saved, "heading_primary", scene);
    assert.ok(rendered.some(node => node.props?.style?.fontSize === 24 && node.props.style.textAlign === "center"));
    if (scene === "mobile") assert.ok(rendered.some(node =>
      node.props?.className === "ele-xform-m-description-text" && node.props.style.textAlign === "center"));
  }
  const target = structuredClone(prepared.update);
  target.mechanisms["sys-xform"].fdConfig = JSON.stringify(saved);
  assert.equal(prepared.verify(target).ok, true);
});

it("honors cell CSS over align attributes and local label CSS over the cell", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  assert.deepEqual(draft.form.fields.find(field => field.id === "heading_secondary").props.style,
    { fontWeight: "bold", fontSize: 23, textAlign: "right" });
  assert.deepEqual(draft.form.fields.find(field => field.id === "heading_local").props.style,
    { fontSize: 20, textAlign: "left" });
});

it("keeps the ordinary 14px native field caption folded and its value constraints unchanged", () => {
  const draft = draftSourceDraft(cleanSourceFile(fixture));
  assert.equal(draft.form.fields.some(field => field.id === "department_caption"), false);
  const field = draft.form.fields.find(field => field.id === "fd_department");
  assert.deepEqual(field.titleStyle, { fontSize: 14, textAlign: "center" });
  assert.equal(field.props.required, true);
  assert.equal(field.props.readOnly, true);
  assert.deepEqual(field.props.defaultValue, { kind: "literal", value: "运营部" });
});

it("rejects reviewed changes to the presentation transferred onto a folded native title", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  draft.form.fields.find(field => field.id === "fd_department").titleStyle.textAlign = "left";
  const check = checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true }));
  assert.equal(check.ok, false);
  assert.ok(check.diagnostics.some(diagnostic => diagnostic.code === "trust.form.presentation_caption_fold_field_mismatch"));
});

for (const scene of ["desktop", "mobile"]) for (const property of ["fontSize", "textAlign"]) {
  it(`verifies ${scene} ${property} after transferring a caption into a native title`, () => {
    const prepared = prepareSample(draftSourceDraft(cleanSourceFile(fixture)));
    const target = structuredClone(prepared.update), config = nativeViewSaveRoundTrip(xformConfig(target));
    const view = JSON.parse(config.viewModel[0].fdConfig);
    assert.deepEqual(view.controlStyle.fd_department[scene].labelStyle[property], property === "fontSize" ? 14 : "center");
    view.controlStyle.fd_department[scene].labelStyle[property] = property === "fontSize" ? 11 : "left";
    config.viewModel[0].fdConfig = JSON.stringify(view);
    target.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    assert.equal(prepared.verify(target).ok, false);
  });
}

for (const [property, value] of [["fontSize", 16], ["textAlign", "left"]]) {
  it(`rejects reviewed DSL that changes source heading ${property}`, () => {
    const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
    draft.form.fields.find(field => field.id === "heading_primary").props.style[property] = value;
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
    const check = checkTrust(source, trusted);
    assert.equal(check.ok, false);
    assert.ok(check.diagnostics.some(diagnostic => diagnostic.code === "trust.form.presentation_description_style_mismatch"));
  });
}

for (const scene of ["desktop", "mobile"]) for (const property of ["fontSize", "textAlign", "alignDesc"]) {
  it(`rejects native readback after losing ${scene} heading ${property}`, () => {
    const prepared = prepareSample(draftSourceDraft(cleanSourceFile(fixture)));
    const target = structuredClone(prepared.update), config = xformConfig(target);
    const view = JSON.parse(config.viewModel[0].fdConfig);
    if (property === "fontSize") delete view.controlStyle.heading_primary[scene].controlValueStyle.fontSize;
    else if (property === "textAlign") view.controlStyle.heading_primary[scene].controlValueStyle.textAlign = "left";
    else view.controlStyle.heading_primary[scene].alignDesc = "left";
    config.viewModel[0].fdConfig = JSON.stringify(view);
    target.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    assert.equal(prepared.verify(target).ok, false);
  });
}

for (const [property, value] of [["fontSize", -1], ["fontSize", "24px"], ["fontSize", Infinity], ["textAlign", "url(unsafe)"]]) {
  it(`rejects unsupported description presentation ${property}=${value}`, () => {
    const draft = draftSourceDraft(cleanSourceFile(fixture));
    draft.form.fields.find(field => field.id === "heading_primary").props.style[property] = value;
    assert.equal(validateMigrationDsl(draft, { mode: "draft" }).ok, false);
  });
}
