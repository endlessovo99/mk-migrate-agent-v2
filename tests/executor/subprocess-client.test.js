import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { NewoaClient, NEWOA_SIT_BASE_URL } from "../../src/executor/newoa-client.js";
import { withNetworkGuard } from "../route-validation/network-guard.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/route-validation/subprocess-dependency/native-reads.json", import.meta.url), "utf8"));
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

describe("native subprocess dependency read contracts", () => {
  it("uses the evidenced exact details and params/find request bodies on the authenticated origin", async () => {
    await withNetworkGuard(async () => {
      const calls = [], responses = [fixture.detailResponse, fixture.paramsResponse];
      const client = new NewoaClient({ fetchImpl: async (url, options) => {
        calls.push({ url, method: options.method, headers: options.headers, body: JSON.parse(options.body) });
        return jsonResponse(responses.shift());
      } });
      client.cookie = "fixture-session=value";
      client.token = "fixture-token";
      assert.deepEqual(await client.getWorkflowTemplateDetail({ templateId: "route-child-template" }), fixture.detailResponse.data);
      assert.deepEqual(await client.getWorkflowSubProcessParams({ templateId: "route-child-template" }), fixture.paramsResponse.data);
      assert.deepEqual(calls.map(({ url, method, body }) => ({ url, method, body })), [
        { url: `${NEWOA_SIT_BASE_URL}/data/sys-lbpm/lbpmTemplate/details`, method: "POST", body: { templateId: "route-child-template" } },
        { url: `${NEWOA_SIT_BASE_URL}/data/sys-lbpm/params/find`, method: "POST", body: {
          reqParams: { processTemplateId: "route-child-template" },
          keys: { processTemplateInfo: ["latestDefinitionId"], processTempVars: ["_all"] }
        } }
      ]);
      assert.equal(calls.every(call => call.headers.cookie === "fixture-session=value" && call.headers.Authorization === "Bearer fixture-token"), true);
    });
  });

  for (const [method, response] of [
    ["getWorkflowTemplateDetail", fixture.missingDetailResponse],
    ["getWorkflowSubProcessParams", fixture.missingParamsResponse]
  ]) it(`retains the structured noRecord error and stable ${method} stage`, async () => {
    const client = new NewoaClient({ fetchImpl: async () => jsonResponse(response.body, response.status) });
    await assert.rejects(client[method]({ templateId: "route-child-template" }), error => {
      assert.equal(error.stage, method);
      assert.deepEqual(error.response, response);
      return true;
    });
  });

  for (const [method, body] of [
    ["getWorkflowTemplateDetail", { data: fixture.detailResponse.data }],
    ["getWorkflowTemplateDetail", { success: true, data: [] }],
    ["getWorkflowSubProcessParams", { data: fixture.paramsResponse.data }],
    ["getWorkflowSubProcessParams", { success: true, data: [] }],
    ["getWorkflowSubProcessParams", { success: true, data: { processTemplateInfo: {}, processTempVars: { _all: [] } } }],
    ["getWorkflowSubProcessParams", { success: true, data: { processTemplateInfo: { latestDefinitionId: "definition" }, processTempVars: {} } }],
    ["getWorkflowSubProcessParams", { success: true, data: { processTemplateInfo: { latestDefinitionId: "definition" }, processTempVars: { _all: {} } } }]
  ]) it(`rejects an incomplete ${method} response without inventing metadata`, async () => {
    const client = new NewoaClient({ fetchImpl: async () => jsonResponse(body) });
    await assert.rejects(client[method]({ templateId: "route-child-template" }), error => {
      assert.equal(error.stage, method);
      assert.equal(error.code, method === "getWorkflowTemplateDetail" ? "newoa.workflow_template_detail_invalid" : "newoa.workflow_subprocess_params_invalid");
      return true;
    });
  });

  it("requires an exact parameter-read identity before issuing a request", async () => {
    let calls = 0;
    const client = new NewoaClient({ fetchImpl: async () => { calls++; throw new Error("must not be called"); } });
    for (const templateId of [undefined, "", "child/id", " child-id "]) {
      await assert.rejects(client.getWorkflowSubProcessParams({ templateId }), error => error.stage === "getWorkflowSubProcessParams");
    }
    assert.equal(calls, 0);
  });

  it("keeps transport failures classified as read failures with no fabricated native response", async () => {
    for (const method of ["getWorkflowTemplateDetail", "getWorkflowSubProcessParams"]) {
      const failure = new Error("fixture transport failure");
      const client = new NewoaClient({ fetchImpl: async () => { throw failure; } });
      await assert.rejects(client[method]({ templateId: "route-child-template" }), error => {
        assert.equal(error, failure);
        assert.equal(error.stage, method);
        assert.equal(error.response, undefined);
        return true;
      });
    }
  });
});
