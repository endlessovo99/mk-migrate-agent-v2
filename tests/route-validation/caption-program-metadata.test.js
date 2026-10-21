import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapXmlStringPuts } from "../../src/translator/xml-utils.js";

const fixture = "tests/fixtures/route-validation/caption-program-metadata/metadata_SysFormTemplate.xml";
function variant(change = () => {}) {
  const props = parseRootHashMapXmlStringPuts(readFileSync(fixture, "utf8")); change(props);
  const directory = mkdtempSync(join(tmpdir(), "caption-program-metadata-"));
  const encode = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    const file = join(directory, "variant_SysFormTemplate.xml");
    writeFileSync(file, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") + "</object></java>");
    const source = cleanSourceFile(file); return { source, draft: draftSourceDraft(source) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

it("keeps unrelated title ownership while independently inventorying all programs beside inert conflicts", () => {
  const { source, draft } = variant();
  const fact = source.form.controls.find(field => field.id === "caption").sourceProps.captionStructure;
  assert.equal(fact.domContext.inlineDomainComplete, true);
  assert.equal(fact.domContext.uninterpretedProgramMetadata.length, 2);
  assert.equal(draft.form.fields.some(field => field.id === "caption"), false);
});

for (const [name, change] of [
  ["a handler beside the table metadata", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('id="unrelated_table"', 'id="unrelated_table" onclick="changePresentation()"'); }],
  ["a handler beside permission metadata", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('<xform:right ', '<xform:right onClick="changePresentation()" '); }],
  ["a dynamic permission value", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('mode_n2="hidden"', 'mode_n2="${mode}"'); }],
  ["a conflicting executable attribute", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('id="unrelated_table"', 'id="unrelated_table" onclick="first()" onClick="second()"'); }],
  ["a title actually inside the ambiguous permission", props => {
    props.fdDisplayJsp = '<xform:right mode_N2="edit" mode_n2="hidden">' + props.fdDisplayJsp + '</xform:right>';
  }]
]) it(`retains the protection for ${name}`, () => {
  const { draft } = variant(change);
  assert.ok(draft.form.fields.some(field => field.id === "caption"));
});
