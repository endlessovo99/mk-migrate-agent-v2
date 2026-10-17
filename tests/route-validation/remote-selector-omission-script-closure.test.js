import assert from "node:assert/strict";
import fs from "node:fs";
import { it } from "node:test";
import { parse } from "acorn";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { remoteSelectorSourceContracts } from "../../src/translator/remote-selector-source-contract.js";
import { remoteSelectorOmissionScriptClosure, remoteSelectorScriptClosure } from "../../src/translator/remote-selector-script-closure.js";

const file = "tests/fixtures/route-validation/remote-selector-omission/route-remote-omission_SysFormTemplate.xml";
function fixture() {
  const template = parseSysFormTemplateXml(fs.readFileSync(file, "utf8"));
  const contracts = Object.values(remoteSelectorSourceContracts(template));
  return [...template.fdDisplayJsp.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match, index) => ({ javascript: match[1], contract: contracts[index] }));
}
function nodes(candidate) {
  const ast = parse(candidate.javascript, { ecmaVersion: "latest" });
  const selector = ast.body.find(item => item.type === "FunctionDeclaration" && item.id?.name.startsWith("pick_"));
  let dialog;
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee?.name === "Dialog_List") dialog = node;
    for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(walk) : walk(value);
  }
  walk(selector);
  return { ...candidate, selector, dialog };
}
const proof = candidate => remoteSelectorOmissionScriptClosure(nodes(candidate));

it("proves only a source-bound retirement unit for GET and generated dependent POST without a wire contract", () => {
  const [main, post] = fixture(), before = structuredClone(post);
  for (const [candidate, method] of [[main, "GET"], [post, "POST"]]) {
    const witness = proof(candidate);
    assert.equal(witness.status, "verified"); assert.equal(witness.grammar, "generated-rest-selector-omission-closed-v1");
    assert.equal(witness.scope.method, method); assert.equal(witness.scope.fieldId, candidate.contract.fieldId);
    assert.match(witness.javascriptSha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(witness.soleSelector, true); assert.equal(witness.functionNames.length, 3);
    assert.deepEqual(witness.functionNames, Object.values(witness.dependencies).sort());
    assert.equal(JSON.stringify(witness).includes("upstream.example.invalid"), false);
    assert.equal(JSON.stringify(witness).includes("Rows.Other"), false);
    assert.equal(Object.hasOwn(witness, "responseSchema"), false);
  }
  const omitted = proof(post);
  assert.equal(omitted.scope.tableId, "rows");
  assert.deepEqual(omitted.prerequisiteFields.map(item => [item.sourceField, item.condition, item.effect]), [["rows.fd_other", "empty-or-null", "picker-only-alert-and-return"]]);
  assert.match(omitted.prerequisiteFields[0].alertSha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(omitted.scaffolding, ["generated-index-replaceAll-polyfill"]);
  assert.deepEqual(post, before);
  assert.equal(remoteSelectorScriptClosure(nodes(post)), undefined, "normal runtime profile must retain its GET-only gate");
  assert.equal(remoteSelectorScriptClosure(nodes(main)).status, "verified");
});

it("rejects unrelated functions, top-level effects, changed callback effects and invented prerequisite scope", () => {
  const post = fixture()[1];
  const changes = [
    source => source + "\nunknownBusinessWrite();",
    source => source + "\nfunction unrelatedApproval(){return 1;}",
    source => source.replace("var hashMapArray=rtnVal.GetHashMapArray();", "unknownBusinessWrite();var hashMapArray=rtnVal.GetHashMapArray();"),
    source => source.replace('var controlId="rows.fd_other";', 'var controlId="rows.fd_unrelated";'),
    source => source.replace('if(value0==""||value0==null)', 'if(value0=="forbidden")'),
    source => source.replace('alert("请先填写第 "+(parseInt(index)+1)', 'alert(unknownCall()+(parseInt(index)+1)'),
    source => source.replace('alert("请先填写 \'Rows.Other\'！");', 'alert("请先填写 \'Rows.Other\'！");document.write("effect");'),
    source => source.replace('var value0=document.getElementsByName', 'var value0=unknownRead'),
    source => source.replace('requestMethod=POST', 'requestMethod=GET'),
    source => source.replace('function callback_fd_code', 'function alert').replace('callback_fd_code,"restDialogXMLData', 'alert,"restDialogXMLData')
  ];
  for (const mutate of changes) assert.equal(proof({ ...post, javascript: mutate(post.javascript) }), undefined);
  const customCallback = structuredClone(post); customCallback.contract.callbacks.RestApiChangeAfter.present = true;
  assert.equal(proof(customCallback), undefined);
  const wrongMethod = structuredClone(post); wrongMethod.contract.requestResource.method = "DELETE";
  assert.equal(proof(wrongMethod), undefined);
});
