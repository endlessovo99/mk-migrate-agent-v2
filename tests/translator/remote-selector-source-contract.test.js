import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { remoteSelectorSourceContracts } from "../../src/translator/remote-selector-source-contract.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
const fixture = "tests/fixtures/route-validation/remote-selector-source-contract/route-remote-source-contract_SysFormTemplate.xml";
const template = parseRootHashMapStringPuts(fs.readFileSync(fixture, "utf8"));

describe("source-bound remote selector contracts", () => {
  it("recovers exact static request, datasource, ordered mappings and disabled SQL outputs without native capability claims", () => {
    const facts = remoteSelectorSourceContracts(template), rest = facts.fd_lookup, sql = facts["fd_lines.fd_code"];
    assert.equal(rest.status, "static"); assert.equal(rest.kind, "REST"); assert.equal(sql.status, "static");
    assert.equal(rest.requestResource.origin, "https://lookup.example.invalid");
    assert.equal(rest.requestResource.method, "GET"); assert.equal(rest.searchKey, "code");
    assert.equal(rest.requestResource.needsPrivateBinding, true); assert.match(rest.requestResource.privateBindingRef, /^source-private:sha256:[a-f0-9]{64}$/);
    assert.equal(sql.businessDataSource.sourceId, "187b25e4e52d8bceb44498b446a8e7fc");
    assert.deepEqual(sql.requestResource.declaredSearchColumns, ["code", "label"]);
    assert.deepEqual(sql.outputMappings.map(item => [item.sourceColumn, item.enabled, item.targetField]), [["DEPARTMENT", true, "fd_lines.fd_department"], ["CODE", false, "fd_lines.fd_code"]]);
    assert.ok(sql.declarations[0].end > sql.declarations[0].start);
    for (const fact of Object.values(facts)) { assert.equal(fact.bindingStatus, "unbound"); assert.equal(fact.targetResourceVerified, false); }
    const json = JSON.stringify(facts);
    for (const secret of ["SYNTHETIC_ONLY_SECRET", "api_key", "/private", "select code,label,department"]) assert.equal(json.includes(secret), false, secret);
  });

  it("retains same-row REST input dependencies and every repeated output target in order", () => {
    const changed = { ...template, fdDesignerHtml: template.fdDesignerHtml.replace("{'inputParams':[]}", () => "{'inputParams':[{'inputParamName':'project','idField':'$fd_lookup$','nameField':'$Lookup$'}]}")
      .replace("{'outParamName':'label','idField':'$fd_label$','nameField':'$Label$'}", () => "{'outParamName':'label','idField':'$fd_label$','nameField':'$Label$'},{'outParamName':'label','idField':'$fd_lookup$','nameField':'$Lookup$'}") };
    const fact = remoteSelectorSourceContracts(changed).fd_lookup;
    assert.equal(fact.status, "static");
    assert.deepEqual(fact.inputMappings, [{ index: 0, parameterName: "project", sourceField: "fd_lookup" }]);
    assert.deepEqual(fact.outputMappings.map(item => item.targetField), ["fd_label", "fd_lookup"]);
  });

  it("does not turn dynamic URLs, expressions, duplicate literals or source identities into static contracts", () => {
    for (const replacement of [
      template.fdDesignerHtml.replace('https://lookup.example.invalid/private?api_key=SYNTHETIC_ONLY_SECRET', 'https://lookup.example.invalid/${field}'),
      template.fdDesignerHtml.replace("{'inputParams':[]}", "{'inputParams':unknownFunction()}"),
      template.fdDesignerHtml.replace("{'inputParams':[]}", "{'inputParams':[],'inputParams':[]}"),
      template.fdDesignerHtml.replace('requestMethod:"GET"', 'requestMethod:window.method'),
      template.fdDesignerHtml.replace('businessType:"RestDialog"', 'businessType:"SQLDialog"'),
      template.fdDesignerHtml + template.fdDesignerHtml.slice(template.fdDesignerHtml.indexOf('<div fd_type="RestDialog"'), template.fdDesignerHtml.indexOf('</div>') + 6)
    ]) assert.equal(remoteSelectorSourceContracts({ ...template, fdDesignerHtml: replacement }).fd_lookup.status, "unproven");
  });

  it("binds callback presence through hashes without exporting callback code or credential parameter names", () => {
    const html = template.fdDesignerHtml.replace('RestApiChangeAfter:""', 'RestApiChangeAfter:"SYNTHETIC_CALLBACK_SECRET"')
      .replace("{'inputParams':[]}", () => "{'inputParams':[{'inputParamName':'apiKey','idField':'$fd_lookup$','nameField':'$Lookup$'}]}");
    const fact = remoteSelectorSourceContracts({ ...template, fdDesignerHtml: html }).fd_lookup;
    assert.equal(fact.status, "unproven"); assert.equal(fact.callbacks.RestApiChangeAfter.present, true);
    assert.equal(JSON.stringify(fact).includes("SYNTHETIC_CALLBACK_SECRET"), false);
    assert.equal(JSON.stringify(fact).includes("apiKey"), false);
  });

  it("counts only actual tags, binds whole raw hashes and keeps relative origins unresolved", () => {
    const markup = template.fdDesignerHtml + '<input value="&lt;div fd_type=\'RestDialog\' fd_values=\'{id:fd_lookup}\'&gt;"/><script>var marker="fd_type=RestDialog";</script>';
    const fact = remoteSelectorSourceContracts({ ...template, fdDesignerHtml: markup }).fd_lookup;
    assert.equal(fact.declarations.length, 1); assert.notEqual(fact.sourceOrigin.designerSha256, remoteSelectorSourceContracts(template).fd_lookup.sourceOrigin.designerSha256);
    const relative = remoteSelectorSourceContracts({ ...template, fdDesignerHtml: template.fdDesignerHtml.replace('https://lookup.example.invalid/private?api_key=SYNTHETIC_ONLY_SECRET', '/lookup') }).fd_lookup;
    assert.equal(relative.requestResource.usesSourceApplicationOrigin, true); assert.equal(relative.requestResource.origin, undefined);
  });
});
