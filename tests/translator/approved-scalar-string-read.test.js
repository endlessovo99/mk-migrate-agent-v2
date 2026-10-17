import assert from "node:assert/strict";
import vm from "node:vm";
import { it } from "node:test";
import { approvedScalarStringReadExpression } from "../../src/translator/approved-scalar-string-read.js";
const field = { id: "fd_choice", type: "radio", componentId: "xform-radio", props: { options: [{ value: "X" }] },
  sourceProps: { designerId: "fd_choice", metadataId: "fd_choice", metadataKind: "simple", metadataAttributes: { type: "String" } } };
const expression = (form = { fields: [field] }, ids = ["fd_choice"]) => approvedScalarStringReadExpression("fd_choice", form, ids);
it("uses an explicit one-String/empty read contract for approved radio and select fields only", () => {
  for (const control of [field, { ...field, type: "singleSelect", componentId: "xform-select" }]) {
    const code = expression({ fields: [control] }); assert.ok(code);
    for (const [input, output] of [["X", "X"], ["", ""], [undefined, ""], [null, ""], [[], ""], [["X"], "X"], [[""], ""]]) {
      assert.equal(vm.runInNewContext(code, { MKXFORM: { getValue: () => input } }), output);
    }
    for (const input of [{ value: "X" }, ["X", "Y"], [null], [undefined], 1, false, Symbol("x")]) {
      assert.throws(() => vm.runInNewContext(code, { MKXFORM: { getValue: () => input } }), e => e === "Expected one selected String value.");
    }
  }
});
it("keeps missing approval, ambiguous/mismatched/non-String/multi/dataOnly fields closed", () => {
  assert.equal(expression(undefined, []), undefined);
  for (const fields of [[], [field, field], [{ ...field, dataOnly: true }], [{ ...field, props: { multiple: true } }],
    [{ ...field, type: "checkbox", componentId: "xform-checkbox" }],
    [{ ...field, sourceProps: { ...field.sourceProps, metadataId: "different" } }],
    [{ ...field, sourceProps: { ...field.sourceProps, metadataAttributes: { type: "Number" } } }],
    [{ ...field, sourceProps: { ...field.sourceProps, metadataKind: "element" } }]]) assert.equal(expression({ fields }), undefined);
});
const projected = {
  ...field,
  sourceProps: { designerId: "fd_choice", designerValues: { dataType: "String" }, mainStringValueBindingFact: {
    version: 1, status: "unproven", fieldId: "fd_choice",
    sourceHashes: { fdDesignerHtml: "a".repeat(64), fdDisplayJsp: "b".repeat(64), fdMetadataXml: "c".repeat(64) },
    metadata: { count: 1, type: "String", declarations: [{ kind: "extendsimpleproperty", type: "String", start: 10, end: 40 }] }
  } }
};
it("retains explicit String metadata proof when only ordinary projection properties were lost", () => {
  const code = expression({ fields: [projected] }); assert.ok(code);
  assert.equal(vm.runInNewContext(code, { MKXFORM: { getValue: () => ["X"] } }), "X");
  assert.equal(expression({ fields: [projected] }, []), undefined);
  const noFact = structuredClone(projected); delete noFact.sourceProps.mainStringValueBindingFact;
  assert.equal(expression({ fields: [noFact] }), undefined);
});
for (const [name, edit] of [
  ["metadata duplicate", fact => { fact.metadata.count = 2; }],
  ["metadata non-String", fact => { fact.metadata.type = "Number"; }],
  ["wrong field", fact => { fact.fieldId = "fd_other"; }],
  ["missing raw hash", fact => { delete fact.sourceHashes.fdMetadataXml; }],
  ["invalid raw hash", fact => { fact.sourceHashes.fdDisplayJsp = "not-a-hash"; }],
  ["wrong fact version", fact => { fact.version = 2; }]
]) it("rejects a projected String witness with " + name, () => {
  const changed = structuredClone(projected); edit(changed.sourceProps.mainStringValueBindingFact);
  assert.equal(expression({ fields: [changed] }), undefined);
});
it("does not override contradictory retained metadata using an alternate witness", () => {
  for (const retained of [{ metadataId: "different" }, { metadataKind: "element" }, { metadataAttributes: { type: "Number" } }])
    assert.equal(expression({ fields: [{ ...projected, sourceProps: { ...projected.sourceProps, ...retained } }] }), undefined);
});
