import assert from "node:assert/strict";
import fs from "node:fs";
import { it } from "node:test";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { parseMetadataXml } from "../../src/translator/sysform-metadata.js";
import { runtimeRadioWidthlessEvidence } from "../../src/translator/designer-content-flow.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const file = "tests/fixtures/route-validation/radio-source-presentation/raw-exporter_SysFormTemplate.xml";
const source = () => parseRootHashMapStringPuts(fs.readFileSync(file, "utf8"));
const evidence = raw => [...runtimeRadioWidthlessEvidence(raw.fdDesignerHtml, raw.fdDisplayJsp, parseMetadataXml(raw.fdMetadataXml).fields)].sort();

it("proves real quoted CRLF, double outer quotes, nonbreaking whitespace and an unquoted required marker without changing source values", () => {
  const raw = source();
  assert.match(raw.fdDesignerHtml, /items:"[^"\r\n]+\r?\n/);
  assert.match(raw.fdDesignerHtml, /fd_values="\{id:"/);
  assert.match(raw.fdDesignerHtml, /class=txtstrong/);
  assert.deepEqual(evidence(raw), ["fd_h2", "fd_h4", "fd_v4"]);
  const draft = draftSourceDraft(cleanSourceFile(file)), prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
  assert.equal(xformConfig(prepared.update).dataModel[0].fdFields.filter(field => field.fdType === "radio").length, 3);
});

it("requires complete literal source values and rejects duplicate, executable, comment and unknown properties", () => {
  for (const suffix of [',id:"fd_h2"', ',sideEffect:call()', ',extra:"unsupported"', ',/* ignored */ alignment:"H"', ',...other']) {
    const raw = source(); raw.fdDesignerHtml = raw.fdDesignerHtml.replace('defaultValue:"A"}', `defaultValue:"A"${suffix}}`);
    assert.equal(evidence(raw).includes("fd_h2"), false, suffix);
  }
});

it("requires complete child topology and static identity instead of matching input/label counts", () => {
  for (const [from, to] of [
    ['type="radio" value="A"', 'type="radio" value="A" onclick="run()"'],
    ['type="radio" value="A"', 'type="radio" value="A" style="width:999px"'],
    ['type="radio" value="A"', 'type="radio" value="A" hidden'],
    ['<LABEL attach="fd_h2">', '<LABEL attach="fd_h2" class="unproved">'],
    ['<LABEL attach="fd_h2">', '<LABEL attach="other">'],
    ['Option 0</LABEL>', 'Option 0</LABEL>unmodelled text'],
    ['<NOBR><INPUT id="fd_h2"', '<DIV><NOBR><INPUT id="fd_h2"'],
    ['class=txtstrong', 'class=unknown']
  ]) {
    const raw = source(); assert.ok(raw.fdDesignerHtml.includes(from), from); raw.fdDesignerHtml = raw.fdDesignerHtml.replace(from, to);
    const affected = from === 'class=txtstrong' ? "fd_h4" : "fd_h2";
    assert.equal(evidence(raw).includes(affected), false, from);
  }
});

it("does not turn encoded markup, hidden ancestors, unknown conditions or server strings into widthless proof", () => {
  for (const [key, transform] of [
    ["fdDesignerHtml", html => html.replaceAll("<", "&lt;").replaceAll(">", "&gt;")],
    ["fdDisplayJsp", html => html.replaceAll("<", "&lt;").replaceAll(">", "&gt;")],
    ["fdDesignerHtml", html => `<DIV hidden>${html}</DIV>`],
    ["fdDisplayJsp", html => `<DIV style="display:none">${html}</DIV>`],
    ["fdDisplayJsp", html => `<c:if test="condition">${html}</c:if>`],
    ["fdDisplayJsp", html => `<% String ignored = '${html}'; %>`]
  ]) {
    const raw = source(); raw[key] = transform(raw[key]); assert.deepEqual(evidence(raw), [], key);
  }
});

it("rejects unknown runtime attributes, options, free text and opaque children", () => {
  for (const [from, to] of [
    ['alignment="H"', 'alignment="H" canShow="false"'],
    ['value="A">Option 0', 'value="changed">Option 0'],
    ['value="A">Option 0', 'value="A" class="unknown">Option 0'],
    ['</xform:simpleDataSource>', '</xform:simpleDataSource>extra'],
    ['</xform:radio>', '<SCRIPT>ignored()</SCRIPT></xform:radio>']
  ]) {
    const raw = source(); assert.ok(raw.fdDisplayJsp.includes(from)); raw.fdDisplayJsp = raw.fdDisplayJsp.replace(from, to);
    assert.equal(evidence(raw).includes("fd_h2"), false, from);
  }
});

it("completes the raw exporter fake route with invariant39 readback and record", async () => {
  const result = await runRouteCase("radio-source-presentation-raw-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.readback.invariantVersion, 40);
  assert.equal(result.execution.transferRecord.status, "recorded");
});
