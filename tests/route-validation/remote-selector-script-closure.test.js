import assert from "node:assert/strict";
import fs from "node:fs";
import { it } from "node:test";
import { parse } from "acorn";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { remoteSelectorSourceContracts } from "../../src/translator/remote-selector-source-contract.js";
import { remoteSelectorScriptClosure } from "../../src/translator/remote-selector-script-closure.js";

const file = "tests/fixtures/route-validation/approved-remote-policies/route-approved-remote_SysFormTemplate.xml";
function fixture() {
  const template = parseSysFormTemplateXml(fs.readFileSync(file, "utf8"));
  const contracts = Object.values(remoteSelectorSourceContracts(template));
  return [...template.fdDisplayJsp.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match, index) => ({ javascript: match[1], contract: contracts[index] }));
}
function proof({ javascript, contract }) {
  const ast = parse(javascript, { ecmaVersion: "latest" });
  const selector = ast.body.find(item => item.type === "FunctionDeclaration" && item.id?.name.startsWith("pick_"));
  let dialog;
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee?.name === "Dialog_List") dialog = node;
    for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(walk) : walk(value);
  }
  walk(selector);
  return remoteSelectorScriptClosure({ javascript, selector, dialog, contract });
}

it("proves complete source getter/callback units and exports hashes and explicit data effects only", () => {
  const [main, detail] = fixture();
  for (const candidate of [main, detail]) {
    const before = structuredClone(candidate), verified = proof(candidate);
    assert.equal(verified.status, "verified"); assert.equal(verified.soleSelector, true);
    assert.match(verified.javascriptSha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(verified.emptyResult, "clear-explicit-outputs"); assert.equal(verified.cancellation, "unchanged");
    assert.deepEqual(verified.inputMappings, candidate.contract.inputMappings); assert.deepEqual(verified.outputMappings, candidate.contract.outputMappings);
    assert.equal(JSON.stringify(verified).includes("upstream.example.invalid"), false);
    assert.equal(JSON.stringify(verified).includes("document.getElementsByName"), false);
    assert.deepEqual(candidate, before);
  }
  assert.equal(proof(main).inputMappings.length, 0);
  assert.deepEqual(proof(detail).inputMappings.map(item => [item.parameterName, item.sourceField]), [["project", "fd_project"]]);
});

it("records source empty-selection no-op distinctly when the generated clear branch is absent", () => {
  const candidate = fixture()[0], guard = "if(rtnVal==null||rtnVal=='undefined'){return;}";
  const secondGuard = candidate.javascript.indexOf(guard, candidate.javascript.indexOf(guard) + guard.length);
  const nextFunction = candidate.javascript.indexOf("\nfunction getInputParamValue_fd_project");
  assert.ok(secondGuard > 0 && nextFunction > secondGuard);
  // Keep the selected-value callback intact; remove only its exact generated
  // empty-array clearing block. The normal policy must reject this witness
  // while the closure accurately describes the authored no-op behavior.
  candidate.javascript = candidate.javascript.slice(0, secondGuard) + "}" + candidate.javascript.slice(nextFunction);
  const verified = proof(candidate);
  assert.equal(verified.status, "verified");
  assert.equal(verified.emptyResult, "unchanged");
  assert.equal(verified.outputMappings.length, 1);
});

it("rejects a Designer-only output claim, missing/altered input forwarding and unknown callback effects", () => {
  const [main, detail] = fixture();
  const changes = [
    [main, source => source.replace("callback_fd_project,\"restDialogXMLData", "null,\"restDialogXMLData")],
    [main, source => source.replace("hashMapArray[i].description==null?\"\":hashMapArray[i].description", "hashMapArray[i].other==null?\"\":hashMapArray[i].other")],
    [main, source => source.replace('setValueObject0.value="";', 'setValueObject0.value="invented";')],
    [main, source => source.replace("var hashMapArray=rtnVal.GetHashMapArray();", "unknownBusinessEffect();var hashMapArray=rtnVal.GetHashMapArray();")],
    [main, source => source + "\nfetch('https://unknown.invalid');"],
    [main, source => source.replace('return false;}', 'unknownBusinessEffect();return false;}')],
    [detail, source => source.replace('inputParameterValues.push({"project":document.getElementsByName("extendDataFormInfo.value(fd_project)")[0].value});', '')],
    [detail, source => source.replace('"extendDataFormInfo.value(fd_project)"', '"extendDataFormInfo.value(fd_region)"')],
    [detail, source => source.replace('"&restApiPath="+restApiPath', '"&restApiPath="+"https://other.invalid"')],
    [detail, source => source.replace('isLoadData=false', 'isLoadData=true')],
    [detail, source => source.replace('searchKey=q', 'searchKey=other')],
    [detail, source => source.replace('idField=idField.replaceAll("!{indexFlag}",index);', '')],
    [detail, source => source.replace('var restApiPath=', 'var unrelated="business";var restApiPath=')],
    [main, source => source.replaceAll("idField", "JSON")]
  ];
  for (const [candidate, mutate] of changes) assert.equal(proof({ ...candidate, javascript: mutate(candidate.javascript) }), undefined);
});

it("proves current-row source reads and the exact legacy eval carrier without evaluating source", () => {
  const detail = fixture()[1], current = structuredClone(detail);
  current.contract.inputMappings[0].sourceField = "rows.fd_other";
  current.javascript = current.javascript.replace('document.getElementsByName("extendDataFormInfo.value(fd_project)")[0].value', 'document.getElementsByName("extendDataFormInfo.value(rows."+index+".fd_other)")[0].value');
  assert.equal(proof(current).status, "verified");
  const legacy = structuredClone(current);
  legacy.javascript = legacy.javascript.replace('document.getElementsByName("extendDataFormInfo.value(rows."+index+".fd_other)")[0].value', 'eval("fieldName=\'extendDataFormInfo.value(rows."+index+".fd_other)\';document.getElementsByName(fieldName)[0].value;")').replace('{"project":eval', '{project:eval');
  assert.equal(proof(legacy).status, "verified");
  assert.equal(proof({ ...legacy, javascript: legacy.javascript.replace('document.getElementsByName(fieldName)[0].value;', 'steal();document.getElementsByName(fieldName)[0].value;') }), undefined);
  const wrongRow = structuredClone(current); wrongRow.contract.inputMappings[0].sourceField = "another_table.fd_other";
  assert.equal(proof(wrongRow), undefined);
});

it("recognizes only the exact generated index compatibility scaffolding and preserves its classification", () => {
  const detail = fixture()[1], polyfill = 'String.prototype.replaceAll=function(s1,s2){return this.replace(new RegExp(s1,"gm"),s2);};';
  assert.deepEqual(proof({ ...detail, javascript: polyfill + detail.javascript }).scaffolding, ["generated-index-replaceAll-polyfill"]);
  for (const addition of [polyfill.replace('"gm"', '"g"'), polyfill + polyfill, polyfill + 'String.prototype.other=function(){return 1;};']) {
    assert.equal(proof({ ...detail, javascript: addition + detail.javascript }), undefined);
  }
});

it("rejects other methods, custom callbacks, stale mapping claims and borrowed AST nodes", () => {
  const main = fixture()[0];
  for (const mutate of [
    contract => { contract.requestResource.method = "POST"; },
    contract => { contract.selection.preload = true; },
    contract => { contract.callbacks.RestApiChangeAfter.present = true; },
    contract => { contract.outputMappings.push({ index: 1, sourceColumn: "missing", targetField: "fd_other", enabled: true }); },
    contract => { contract.inputMappings.push({ index: 0, parameterName: "missing", sourceField: "fd_other" }); }
  ]) { const changed = structuredClone(main); mutate(changed.contract); assert.equal(proof(changed), undefined); }
  const ast = parse(main.javascript, { ecmaVersion: "latest" }), selector = ast.body.at(-1), dialog = selector.body.body.find(item => item.expression?.callee?.name === "Dialog_List").expression;
  assert.equal(remoteSelectorScriptClosure({ ...main, javascript: main.javascript.replace("function pick_fd_project", "function another_selector"), selector, dialog }), undefined);
});
