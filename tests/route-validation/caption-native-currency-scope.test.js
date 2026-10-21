import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapXmlStringPuts } from "../../src/translator/xml-utils.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/caption-native-currency-scope/runtime-include_SysFormTemplate.xml";
const folded = draft => draft.form.fields.some(field => field.id === "fd_note" && field.sourceProps?.foldedCaption);
function variant(change) {
  const props = parseRootHashMapXmlStringPuts(readFileSync(fixture, "utf8")); change(props);
  const directory = mkdtempSync(join(tmpdir(), "caption-currency-"));
  const encode = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    const file = join(directory, "variant_SysFormTemplate.xml");
    writeFileSync(file, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") + "</object></java>");
    const source = cleanSourceFile(file); return { source, draft: draftSourceDraft(source) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

it("bounds the native runtime-only include from matching typed source and readonly runtime evidence", () => {
  const { source, draft } = variant(() => {});
  assert.equal(source.scripts.sources.some(script => script.javascript.includes("chinaValue_script")), false,
    "The include is independently inventoried from runtime, not the designer-first registry");
  assert.equal(folded(draft), true);
  assert.deepEqual(draft.scripts, draftSourceDraft(withoutCaptionRelations(structuredClone(source))).scripts);
  const projection = structuredClone(draft); projection.scripts = { actions: [] };
  const prepared = prepareSample(projection); assert.equal(prepared.verify(prepared.update).ok, true);
});

for (const [name, change] of [
  ["an unknown include URL", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace("../sys/xform/designer/chinaValue/", "../custom/currency/"); }],
  ["a mismatching runtime relation", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace("relatedid='fd_amount'", "relatedid='fd_note'"); }],
  ["an editable runtime value", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('showStatus="readOnly"', 'showStatus="edit"'); }],
  ["a nonnumeric amount source", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('dataType:"Double"', 'dataType:"String"'); props.fdMetadataXml = props.fdMetadataXml.replace('type="Double"', 'type="String"'); }],
  ["extra code in the include program", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace("Com_IncludeFile('chinaValue_script", "changePresentation();Com_IncludeFile('chinaValue_script"); }]
]) it(`retains titles for ${name}`, () => { assert.equal(folded(variant(change).draft), false); });
