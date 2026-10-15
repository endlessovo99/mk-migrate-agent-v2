import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { validateWorkflowSignOptions, inspectSourceSignNode, validateSourceSignIntegrity } from "../../src/dsl/workflow-sign-contract.js";
import { canonicalSignOperationSet, signOperationSetDigest, prepareSignPolicy, verifySignPolicyReadback } from "../../src/executor/workflow-sign-policy.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
const read = name => JSON.parse(readFileSync(new URL(`../fixtures/route-validation/workflow-sign/${name}`, import.meta.url)));
const clone = value => structuredClone(value);
const source = cleanSourceFile("tests/fixtures/route-validation/workflow-sign"), dsl = draftSourceDraft(source), entity = read("operation-set.json");
const options = () => ({
  workflowSignDocumentPolicy: "form-only-audit",
  workflowOperationSetOverrides: [{ sourceNodeType: "signNode", sourceOperationRefId: "fixture-source-operations", targetNodeType: "sign", targetFlowType: "0", targetOperationRefId: entity.fdId, expectedDefault: true, expectedSemanticDigest: signOperationSetDigest(entity) }]
});
const observedNodes = () => dsl.workflow.nodes.filter(n => n.type === "sign").map(n => ({ id: n.id, type: "sign", element: "manualTask", operationRefId: entity.fdId, operations: [] }));
it("accepts only explicit sign options and retains six source document flags", () => {
  assert.equal(validateWorkflowSignOptions(options()).ok, true);
  assert.equal(validateSourceSignIntegrity(source, dsl).ok, true);
  const before = JSON.stringify({ source, dsl, entity });
  const prepared = prepareSignPolicy(dsl, options(), [entity]);
  assert.deepEqual(prepared.documentAudit.map(x => x.sourceValue), ["true","false","false","true","true","true"]);
  assert.ok(prepared.documentAudit.every(x => x.disposition === "audit-only" && x.targetPermissionMapped === false));
  assert.equal(prepared.nodes.length, 6); assert.equal(prepared.operationSets.length, 1);
  assert.equal(verifySignPolicyReadback(prepared, observedNodes(), [entity]).ok, true);
  assert.equal(JSON.stringify({ source, dsl, entity }), before);
});
for (const bad of [false, true, "ignorePermissions", 1, {}, null]) it(`rejects document policy ${JSON.stringify(bad)}`, () => {
  const config = options(); config.workflowSignDocumentPolicy = bad;
  assert.equal(validateWorkflowSignOptions(config).ok, false);
  assert.throws(() => prepareSignPolicy(dsl, config, [entity]));
});
it("rejects absent policy for explicit true or false source values but never invents false for absence", () => {
  const config = options(); delete config.workflowSignDocumentPolicy;
  assert.throws(() => prepareSignPolicy(dsl, config, [entity]));
  const absent = clone(dsl); for (const node of absent.workflow.nodes.filter(n => n.type === "sign")) delete node.definition.attributes.canModifyMainDoc;
  const prepared = prepareSignPolicy(absent, config, [entity]);
  assert.ok(prepared.documentAudit.every(x => !Object.hasOwn(x, "sourceValue") && x.disposition === "not-present"));
});
for (const [label, mutate] of [
  ["source ref changed", n => n.definition.operations[0].attributes.refId = "changed"],
  ["source document flag deleted", n => delete n.definition.attributes.canModifyMainDoc],
  ["source document flag false", n => n.definition.attributes.canModifyMainDoc = "false"],
  ["typed sign changed to review", n => n.type = "review"],
  ["source type changed", n => n.sourceType = "reviewNode"],
  ["other permission changed", n => n.definition.attributes.canModifyFlow = "true"],
  ["source handler deleted", n => n.handlerEntities.pop()]
]) it(`protects immutable source evidence: ${label}`, () => {
  const candidate = clone(dsl); mutate(candidate.workflow.nodes.find(n => n.sourceType === "signNode"));
  assert.equal(validateSourceSignIntegrity(source, candidate).ok, false);
});
for (const [label, mutate] of [
  ["missing reference", n => delete n.definition.operations],
  ["duplicate reference", n => n.definition.operations.push(clone(n.definition.operations[0]))],
  ["unexpected nested content", n => n.definition.operations[0].childElementCount = 1],
  ["unexpected text", n => n.definition.operations[0].text = "unknown"],
  ["unknown document flag", n => n.definition.attributes.canModifyMainDoc = "yes"],
  ["boolean document flag", n => n.definition.attributes.canModifyMainDoc = true],
  ["direct definition conflict", n => n.attributes.canModifyMainDoc = "false"],
  ["different direct operation ref", n => n.operations = [{ ...clone(n.definition.operations[0]), attributes: { refId: "other" } }]]
]) it(`rejects unsupported source structure: ${label}`, () => {
  const node = clone(source.workflow.nodes.find(n => n.sourceType === "signNode")); mutate(node); assert.throws(() => inspectSourceSignNode(node));
});
it("keeps consistent repeated direct/definition facts and unrelated review nodes narrow", () => {
  const node = clone(source.workflow.nodes.find(n => n.sourceType === "signNode")); node.attributes.canModifyMainDoc = "true"; node.operations = clone(node.definition.operations);
  assert.equal(inspectSourceSignNode(node).sourceOperationRefId, "fixture-source-operations");
  const normal = { workflow: { nodes: [{ id: "R", sourceType: "reviewNode", type: "review", attributes: { canModifyMainDoc: "true" } }] } };
  assert.deepEqual(prepareSignPolicy(normal, {}, []), { nodes: [], documentAudit: [], operationSets: [] });
  assert.throws(() => prepareSignPolicy(normal, options(), [entity]));
});
for (const [label, mutate] of [
  ["wrong source type", c => c.sourceNodeType = "reviewNode"],
  ["wrong target type", c => c.targetNodeType = "review"],
  ["wrong flow", c => c.targetFlowType = "1"],
  ["false default", c => c.expectedDefault = false],
  ["symbolic default ref", c => c.targetOperationRefId = "default"],
  ["custom ref", c => c.targetOperationRefId = "custom"],
  ["invalid digest", c => c.expectedSemanticDigest = "not-a-digest"],
  ["unknown config key", c => c.ignorePermissions = true]
]) it(`rejects option widening: ${label}`, () => {
  const config = options(); mutate(config.workflowOperationSetOverrides[0]);
  assert.equal(validateWorkflowSignOptions(config).ok, false);
});
it("rejects duplicate source mapping and mismatched configured source reference", () => {
  const config = options(); config.workflowOperationSetOverrides.push(clone(config.workflowOperationSetOverrides[0]));
  assert.equal(validateWorkflowSignOptions(config).ok, false);
  config.workflowOperationSetOverrides.pop(); config.workflowOperationSetOverrides[0].sourceOperationRefId = "unmatched";
  assert.throws(() => prepareSignPolicy(dsl, config, [entity]));
});
it("canonicalizes JSON key ordering without injecting null or deleting no-value attributes", () => {
  const value = canonicalSignOperationSet(entity);
  assert.deepEqual(value.operations[1].attributes.find(x => x.id === "fdLanguage"), { id: "fdLanguage" });
  const reordered = Object.fromEntries(Object.entries(entity).reverse());
  assert.equal(signOperationSetDigest(reordered), signOperationSetDigest(entity));
  const changed = clone(entity); const attrs = JSON.parse(changed.fdOperations[1].fdAttributes); attrs.find(x => x.id === "fdLanguage").value = null; changed.fdOperations[1].fdAttributes = JSON.stringify(attrs);
  assert.notEqual(signOperationSetDigest(changed), signOperationSetDigest(entity));
});
it("allows attribute row reorder but preserves operation order/index and every raw attribute value", () => {
  const reordered = clone(entity); reordered.fdOperations[0].fdAttributes = JSON.stringify(JSON.parse(reordered.fdOperations[0].fdAttributes).reverse());
  assert.equal(signOperationSetDigest(reordered), signOperationSetDigest(entity));
  const changed = clone(entity); changed.fdOperations.reverse(); assert.notEqual(signOperationSetDigest(changed), signOperationSetDigest(entity));
  changed.fdOperations.reverse(); changed.fdOperations[0].fdIndex++; assert.notEqual(signOperationSetDigest(changed), signOperationSetDigest(entity));
});
for (const [label, mutate] of [
  ["wrong entity identity", e => e.fdId = "other"],
  ["wrong node type", e => e.fdNodeType = "review"],
  ["wrong flow", e => e.fdFlowType = "1"],
  ["default drift", e => e.fdIsDefault = false],
  ["operation deleted", e => e.fdOperations.pop()],
  ["operation added", e => e.fdOperations.push(clone(e.fdOperations[0]))],
  ["sign converted to pass", e => e.fdOperations[3].fdType = "handler_pass"],
  ["wrong operation identity", e => e.fdOperations[3].fdIdentity = 1],
  ["required flag removed", e => { const a=JSON.parse(e.fdOperations[3].fdAttributes); e.fdOperations[3].fdAttributes=JSON.stringify(a.filter(x=>x.id!=="isContentRequired")); }],
  ["required flag disabled", e => { const a=JSON.parse(e.fdOperations[4].fdAttributes); a.find(x=>x.id==="isContentRequired").value=false; e.fdOperations[4].fdAttributes=JSON.stringify(a); }],
  ["duplicate attribute id", e => { const a=JSON.parse(e.fdOperations[0].fdAttributes);a.push(clone(a[0]));e.fdOperations[0].fdAttributes=JSON.stringify(a); }],
  ["other attribute drift", e => { const a=JSON.parse(e.fdOperations[0].fdAttributes);a.find(x=>x.id==="notifyMessage").value="changed";e.fdOperations[0].fdAttributes=JSON.stringify(a); }]
]) it(`blocks before projection and after readback: ${label}`, () => {
  const config = options(), prepared = prepareSignPolicy(dsl, config, [entity]);
  const changed = clone(entity); mutate(changed);
  assert.throws(() => prepareSignPolicy(dsl, config, [changed]));
  assert.equal(verifySignPolicyReadback(prepared, observedNodes(), [changed]).ok, false);
});
for (const [label, mutate] of [
  ["node type", n => n[0].type = "review"], ["element", n => n[0].element = "robot"],
  ["reference", n => n[0].operationRefId = "custom"], ["inline operations", n => n[0].operations.push({ type: "handler_sign" })],
  ["missing node", n => n.pop()], ["extra node", n => n.push({ ...clone(n[0]), id: "EXTRA" })]
]) it(`independently rejects native ${label} mismatch`, () => {
  const prepared = prepareSignPolicy(dsl, options(), [entity]), nodes = observedNodes(); mutate(nodes);
  assert.equal(verifySignPolicyReadback(prepared, nodes, [entity]).ok, false);
});

it("uses only the exact readonly operation-set endpoint and validates its successful identity", async () => {
  const { NewoaClient } = await import("../../src/executor/newoa-client.js");
  const calls = [];
  const client = new NewoaClient({ baseUrl: "https://fixture.invalid", fetchImpl: async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ success: true, data: entity }));
  } });
  assert.deepEqual(await client.getWorkflowOperationSet(entity.fdId), entity);
  assert.deepEqual(calls, [{ url: "https://fixture.invalid/data/sys-lbpm/lbpmOperMain/get", method: "POST", body: { fdId: entity.fdId } }]);
  await assert.rejects(client.getWorkflowOperationSet("default"));
  assert.equal(calls.length, 1);
  for (const response of [{ success: false, data: entity }, { success: true, data: { ...entity, fdId: "other" } }]) {
    client.fetch = async () => new Response(JSON.stringify(response));
    await assert.rejects(client.getWorkflowOperationSet(entity.fdId));
  }
});

it("rejects non-finite parsed attribute numbers instead of canonicalizing them to null", () => {
  const changed = clone(entity);
  changed.fdOperations[0].fdAttributes = changed.fdOperations[0].fdAttributes.replace("\"value\":false", "\"value\":1e999");
  assert.throws(() => canonicalSignOperationSet(changed), /operation_attribute_value_invalid/);
});
