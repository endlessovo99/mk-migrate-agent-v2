import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { remoteSelectorSourceContracts } from "../../src/translator/remote-selector-source-contract.js";
import { remoteSelectorOmissionDuplicateAnchors } from "../../src/translator/remote-selector-omission-duplicates.js";

const file = "tests/fixtures/route-validation/remote-selector-omission/route-remote-omission_SysFormTemplate.xml";
const hash = value => "sha256:" + createHash("sha256").update(value).digest("hex");
function fixture() {
  const template = parseSysFormTemplateXml(fs.readFileSync(file, "utf8")), contract = remoteSelectorSourceContracts(template)["rows.fd_code"];
  const javascript = [...template.fdDisplayJsp.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
  const duplicate = '<table id="TABLE_DL_rows"><c:forEach items="${_xformForm.extendDataFormInfo.formData.rows}" varStatus="vstatus" var="_xformEachBean"><tr type="templateRow"><td>' +
    '<xform:text property="extendDataFormInfo.value(rows.${vstatus.index}.fd_code)" showStatus="noShow"/>' +
    '<xform:text property="extendDataFormInfo.value(rows.${vstatus.index}.fd_code_name)" htmlElementProperties="readOnly=\'readOnly\'"/>' +
    '<script>' + javascript + '</script><a onclick="pick_fd_code(\'${vstatus.index}\')">Select</a></td></tr></c:forEach></table>';
  return { html: template.fdDisplayJsp + duplicate, contract, javascriptSha256: hash(javascript.trim()), duplicate, javascript };
}
const proof = candidate => remoteSelectorOmissionDuplicateAnchors(candidate);

it("proves only same-table JSP existing-row replicas with matching dual roles and complete script identity", () => {
  const candidate = fixture(), before = structuredClone(candidate), found = proof(candidate);
  assert.equal(found.length, 1);
  const item = found[0]; assert.equal(item.tableId, "rows"); assert.equal(item.fieldId, "fd_code"); assert.equal(item.rowVariable, "vstatus"); assert.equal(item.selectorName, "pick_fd_code");
  assert.equal(item.javascriptSha256, candidate.javascriptSha256);
  for (const [start, end, digest] of [["anchorStart", "anchorEnd", "sha256"], ["cellStart", "cellEnd", "cellSha256"], ["loopStart", "loopEnd", "loopSha256"], ["scriptStart", "scriptEnd", "scriptSha256"]]) {
    assert.ok(item[start] >= 0 && item[end] > item[start]); assert.equal(hash(candidate.html.slice(item[start], item[end])), item[digest]);
  }
  assert.deepEqual(item.bindings.map(binding => binding.role), ["primary-hidden", "display-readonly"]);
  assert.equal(JSON.stringify(item).includes("upstream.example.invalid"), false); assert.equal(JSON.stringify(item).includes("Rows.Other"), false);
  assert.deepEqual(candidate, before);
});

it("keeps same-named anchors foreign unless loop identity, row argument, dual bindings and script all match", () => {
  const candidate = fixture();
  const mutations = [
    text => text.replace('id="TABLE_DL_rows"', 'id="TABLE_DL_other"'),
    text => text.replace('formData.rows}', 'formData.other}'),
    text => text.replace('varStatus="vstatus"', 'varStatus="wrongStatus"'),
    text => text.replace('var="_xformEachBean"', 'var="vstatus"'),
    text => text.replace('type="templateRow"', 'type="ordinaryRow"'),
    text => text.replace("pick_fd_code('${vstatus.index}')", "pick_fd_code('!{index}')"),
    text => text.replace("pick_fd_code('${vstatus.index}')", "pick_fd_code('${vstatus.index}');unrelatedEffect()"),
    text => text.replace('rows.${vstatus.index}.fd_code)', 'rows.${vstatus.index}.fd_other)'),
    text => text.replace('rows.${vstatus.index}.fd_code_name)', 'other.${vstatus.index}.fd_code_name)'),
    text => text.replace('showStatus="noShow"', 'showStatus="edit"'),
    text => text.replace("readOnly='readOnly'", "readOnly='false'"),
    text => text.replace('<script>', '<script src="https://external.example.invalid/source.js">'),
    text => text.replace('</script>', 'unrelatedEffect();</script>'),
    text => text.replace('</td>', '<a onclick="pick_fd_code(\'${vstatus.index}\')">Duplicate</a></td>'),
    text => '<table id="TABLE_DL_rows"></table>' + text,
    text => text.replace('<tr type="templateRow">', '<c:forEach items="${other}" varStatus="nested" var="bean"><tr type="templateRow">').replace('</tr>', '</tr></c:forEach>')
  ];
  for (const mutate of mutations) assert.deepEqual(proof({ ...candidate, html: mutate(candidate.duplicate) }), []);
  assert.deepEqual(proof({ ...candidate, html: candidate.duplicate.replace(/<c:forEach[^>]*>/, "").replace('</c:forEach>', '') }), []);
});

it("does not let a caller-supplied matching hash authorize arbitrary source code or unrelated dependencies", () => {
  const candidate = fixture();
  for (const addition of ['unrelatedEffect();', 'function unrelatedApproval(){return 1;}']) {
    const javascript = candidate.javascript + addition, html = candidate.duplicate.replace(candidate.javascript, javascript);
    assert.deepEqual(proof({ ...candidate, html, javascriptSha256: hash(javascript.trim()) }), []);
  }
  const unrelated = '<a onclick="pick_fd_code(\'${vstatus.index}\')">Business caller</a>', combined = { ...candidate, html: candidate.html + unrelated };
  const verified = proof(combined);
  assert.equal(verified.length, 1); assert.ok(verified[0].anchorEnd < combined.html.length - unrelated.length);
  assert.equal(verified.some(item => item.anchorStart === combined.html.lastIndexOf('<a ')), false);
});
