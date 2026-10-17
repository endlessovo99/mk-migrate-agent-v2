import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { mainStringValueBindingFacts } from "../../src/translator/main-string-value-binding.js";

const fixture = JSON.parse(fs.readFileSync("tests/fixtures/translator/main-string-value-binding/template.json", "utf8"));
const fact = template => mainStringValueBindingFacts(template).fd_state;
const raw = '<input type="hidden" name="extendDataFormInfo.value(fd_state)"/>';
const sha = text => createHash("sha256").update(text).digest("hex");

describe("raw source singleton String binding facts", () => {
  it("counts a standard widget and its one inner input once, independently from runtime", () => {
    const proof = fact(fixture);
    assert.equal(proof.status, "verified");
    assert.equal(proof.surfaces.designer.logicalBindingCount, 1);
    assert.equal(proof.surfaces.display.logicalBindingCount, 1);
    for (const key of ["fdDesignerHtml", "fdDisplayJsp", "fdMetadataXml"]) assert.equal(proof.sourceHashes[key], sha(fixture[key]));
    assert.ok(proof.surfaces.designer.bindings[0].end > proof.surfaces.designer.bindings[0].start);
  });

  it("rejects duplicate widgets, extra raw bindings, and two inner value inputs", () => {
    for (const html of [fixture.fdDesignerHtml.repeat(2), fixture.fdDesignerHtml + raw,
      fixture.fdDesignerHtml.replace("</div>", '<input id="fd_state"/></div>')]) {
      assert.equal(fact({ ...fixture, fdDesignerHtml: html }).status, "unproven", html);
    }
    const doubled = fact({ ...fixture, fdDisplayJsp: raw + fixture.fdDisplayJsp });
    assert.equal(doubled.status, "unproven");
    assert.equal(doubled.surfaces.display.logicalBindingCount, 2);
  });

  it("requires a real runtime binding and does not add alternative surface counts", () => {
    for (const fdDisplayJsp of ["", "<script>GetXFormFieldValueById('fd_state');</script>",
      '<xform:editShow>' + raw + '</xform:editShow>',
      '<c:if test="${condition}">' + raw + '</c:if>',
      '<%@ include file="/resource/jsp/common.jsp" %>' + raw,
      '<% if (condition) { %>' + raw + '<% } %>']) {
      assert.equal(fact({ ...fixture, fdDisplayJsp }).status, "unproven", fdDisplayJsp);
    }
    assert.equal(fact({ ...fixture, fdDisplayJsp: '<xform:xtext property="extendDataFormInfo.value(fd_state)" showStatus="noShow" dataType="String"/>' }).status, "verified");
  });

  it("does not infer String or hidden status from a deduplicated field record", () => {
    for (const changed of [
      { fdMetadataXml: fixture.fdMetadataXml.replace('type="String"', 'type="Double"') },
      { fdMetadataXml: fixture.fdMetadataXml.replace('</metadata>', '<extendSimpleProperty name="fd_state" type="String"/></metadata>') },
      { fdMetadataXml: fixture.fdMetadataXml.replace('extendSimpleProperty', 'extendElementProperty') },
      { fdDesignerHtml: fixture.fdDesignerHtml.replace('canShow:"false"', 'canShow:"true"') },
      { fdDisplayJsp: raw.replace('type="hidden"', 'type="text"') },
      { fdDisplayJsp: '<div style="display:none">' + raw.replace('type="hidden"', 'type="checkbox"') + '</div>' },
      { fdDisplayJsp: '<xform:xtext property="extendDataFormInfo.value(fd_state)" showStatus="noShow" multiple="true"/>' },
      { fdDesignerHtml: '' }
    ]) assert.equal(fact({ ...fixture, ...changed }).status, "unproven", JSON.stringify(changed));
  });

  it("checks all canonical name/property slots and dynamic names rather than only DOM ids", () => {
    for (const slot of ["name", "property", "propertyId", "propertyName"]) {
      const extra = raw.replace('name=', slot + '=');
      assert.equal(fact({ ...fixture, fdDesignerHtml: fixture.fdDesignerHtml + extra }).status, "unproven", slot);
    }
    for (const extra of [
      '<input type="hidden" name="${dynamicName}"/>',
      '<input type="hidden" name="extendDataFormInfo.value(${field})"/>',
      '<input name="extendDataFormInfo.value(fd_state)" name="other"/>',
      '<unknown:render property="extendDataFormInfo.value(fd_state)"/>',
      '<textarea name="extendDataFormInfo.value(fd_state)"></textarea>',
      '<pre>' + raw + '</pre>',
      '<input name="extendDataFormInfo.value(fd_state)"'
    ]) assert.equal(fact({ ...fixture, fdDisplayJsp: fixture.fdDisplayJsp + extra }).status, "unproven", extra);
  });

  it("does not parse quoted attribute values, comments or script strings as real controls", () => {
    const carrier = '<input type="hidden" value="&lt;input name=\'extendDataFormInfo.value(fd_state)\'&gt;"/>';
    const comment = '<!-- <input name="extendDataFormInfo.value(fd_state)"/> -->';
    const script = '<script>var markup="<input name=\'extendDataFormInfo.value(fd_state)\'>";</script>';
    const proof = fact({ ...fixture, fdDesignerHtml: fixture.fdDesignerHtml + carrier + comment,
      fdDisplayJsp: fixture.fdDisplayJsp + script });
    assert.equal(proof.status, "verified");
    assert.equal(proof.surfaces.display.logicalBindingCount, 1);
  });

  it("refuses executable dynamic binding construction, attribute renaming and opaque libraries", () => {
    for (const extra of [
      '<script>document.body.appendChild(document.createElement("input"));</script>',
      '<script>var x=GetXFormFieldById("fd_state")[0];x.name="other";</script>',
      '<script>unknownLibrary();</script>', '<script src="unknown.js"></script>',
      '<input onclick="document.createElement(\'input\')"/>',
      '<div fd_type="jsp"><input type="hidden" value="&lt;script&gt;unknownLibrary()&lt;/script&gt;"/></div>',
      '<script>var GetXFormFieldValueById=function(){return ["A","B"]};</script>'
    ]) assert.equal(fact({ ...fixture, fdDisplayJsp: fixture.fdDisplayJsp + extra }).status, "unproven", extra);
  });
});
