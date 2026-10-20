import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { draftSourceDraft } from "../../src/translator/index.js";
// These width assertions cover retained SourceDrafts and their standalone native caption layouts.
import { cleanSourceWithoutCaptionFact as cleanSourceFile } from "../helpers/retained-caption-source.js";
import { sourceMobileCaptionGrids } from "../../src/dsl/source-mobile-caption-grid.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

for (const [name, encoded] of [["double-named", "&amp;lt;input"], ["double-numeric", "&amp;#60;input"]]) {
  it(`does not promote a ${name} escaped payload into a genuine source hidden marker`, () => {
    const path = `tests/fixtures/route-validation/mobile-caption-marker-boundary/${name}_SysFormTemplate.xml`;
    const parsed = parseSysFormTemplateXml(readFileSync(path, "utf8"));
    assert.ok(parsed.fdDesignerHtml.includes(`value="${encoded}`), "Real XML attribute context, not a synthesized DSL proof");
    const dsl = draftSourceDraft(cleanSourceFile(path));
    const caption = dsl.form.fields.find(field => field.id === "caption_kind");
    assert.notEqual(caption.sourceProps.runtimePlainCaption, true);
    assert.equal(caption.sourceProps.runtimePlainCaptionMarkerIds, undefined);
    assert.equal(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"), false);
    assert.deepEqual(dsl.form.fields.find(field => field.id === "opaque_state").props.defaultValue,
      { kind: "literal", value: "retained-state" });
    const prepared = prepareSample(dsl), view = JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);
    assert.deepEqual(view.view.render.mobile, view.view.render.desktop);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });
}

for (const name of ["wrapper-extra-script", "icon-extra-script"]) {
  it(`does not ignore a real extra SCRIPT in the complete ${name} source body`, () => {
    const path = `tests/fixtures/route-validation/mobile-caption-marker-boundary/${name}_SysFormTemplate.xml`;
    const parsed = parseSysFormTemplateXml(readFileSync(path, "utf8"));
    assert.ok(parsed.fdDesignerHtml.includes("<SCRIPT>sourceEffect();</SCRIPT>"));
    const source = cleanSourceFile(path), dsl = draftSourceDraft(source);
    assert.equal(source.scripts?.sources?.length || 0, 0, "The existing fragment extractor does not expose this outside-carrier SCRIPT");
    assert.equal(dsl.scripts?.actions?.length || 0, 0, "Do not claim a pending action provides protection here");
    const caption = dsl.form.fields.find(field => field.id === "caption_kind");
    assert.notEqual(caption.sourceProps.runtimePlainCaption, true);
    assert.equal(caption.sourceProps.runtimePlainCaptionMarkerIds, undefined);
    assert.equal(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"), false);
  });
}
