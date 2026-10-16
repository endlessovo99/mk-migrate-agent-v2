import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { extractSysFormJspScripts } from "../../src/translator/sysform-jsp-scripts.js";
import { sourceMobileCaptionGrids } from "../../src/dsl/source-mobile-caption-grid.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixture = name => `tests/fixtures/route-validation/mobile-mixed-caption-raw-carrier/${name}_SysFormTemplate.xml`;
const marker = '<input type="hidden" id="opaque_state" name="opaque_state" value="retained-state"/>';
const grid = (view, scene) => view.view.render[scene][0].children[0].children[0].children.find(node => node.type === "@elem/layout-grid");

it("uses the actual raw single-quoted carrier spelling without changing source fragment or helper semantics", () => {
  const template = parseSysFormTemplateXml(readFileSync(fixture("raw-carrier"), "utf8"));
  assert.ok(template.fdDesignerHtml.includes(`value='${marker}'`));
  assert.equal(extractSysFormJspScripts(template).fragments[0].content, marker);
  const source = cleanSourceFile(fixture("raw-carrier")), dsl = draftSourceDraft(source);
  const helper = dsl.form.fields.find(field => field.id === "opaque_state");
  assert.equal(helper.dataOnly, true);
  assert.deepEqual(helper.props.defaultValue, { kind: "literal", value: "retained-state" });
  const prepared = prepareSample(dsl);
  assert.equal(prepared.verify(prepared.update).ok, true, "This is a valid existing native request, not a parser setup failure");
});

it("retains full source proof and hybrid mobile tracks for the genuine raw carrier syntax", () => {
  const dsl = draftSourceDraft(cleanSourceFile(fixture("raw-carrier")));
  assert.equal(dsl.form.fields.find(field => field.id === "caption_kind").sourceProps.runtimePlainCaption, true);
  assert.ok(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"));
  const prepared = prepareSample(dsl), view = JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);
  const pc = grid(view, "desktop"), mobile = grid(view, "mobile");
  assert.deepEqual(mobile.controlProps.colsStyle, pc.controlProps.colsStyle.map((style, index) => ({
    ...style, value: index < 3 ? `minmax(max-content, ${Number.parseFloat(style.value)}fr)` : style.value
  })));
  assert.deepEqual(mobile.controlProps.style, { overflowX: "auto" });
  assert.deepEqual(mobile.children, pc.children);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("does not consume only a valid-looking prefix when the raw carrier has an extra handler", () => {
  const template = parseSysFormTemplateXml(readFileSync(fixture("raw-carrier-extra-attribute"), "utf8"));
  assert.ok(template.fdDesignerHtml.includes(`value='${marker}' onclick="unknown()"`));
  const dsl = draftSourceDraft(cleanSourceFile(fixture("raw-carrier-extra-attribute")));
  assert.notEqual(dsl.form.fields.find(field => field.id === "caption_kind").sourceProps.runtimePlainCaption, true);
  assert.equal(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"), false);
  const view = JSON.parse(xformConfig(prepareSample(dsl).update).viewModel[0].fdConfig);
  assert.deepEqual(grid(view, "mobile"), grid(view, "desktop"));
});
