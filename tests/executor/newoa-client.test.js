import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertAllowedBaseUrl,
  NewoaClient,
  NEWOA_SIT_BASE_URL
} from "../../src/executor/newoa-client.js";

describe("NewoaClient", () => {
  it("uses injected fetch for the complete authenticated template contract", async () => {
    const calls = [];
    const responses = [
      jsonResponse({ success: true, data: { token: "token-1" } }, {
        cookies: ["JSESSIONID=session-1; Path=/; HttpOnly", "route=node-a; Path=/"]
      }),
      jsonResponse({ success: true, data: { fdId: "init-1" } }),
      jsonResponse({ success: true, data: "mk_table_1" }),
      jsonResponse({ success: true, data: { fdFormCategoryId: "category-1", fdName: "测试分类" } }),
      jsonResponse({ success: true, data: { id: "created-1", fdName: "MK_TEST_示例" } }),
      jsonResponse({ success: true, data: { fdId: "created-1", fdName: "MK_TEST_示例" } }),
      jsonResponse({ success: true, data: { fdId: "created-1" } })
    ];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      const response = responses.shift();
      assert.ok(response, `unexpected fetch call: ${url}`);
      return response;
    };
    const client = new NewoaClient({ fetchImpl });
    const credentials = {
      username: "contract-user",
      encryptedPassword: "contract-encrypted-password"
    };
    const addPayload = { fdName: "MK_TEST_示例", fdCategory: { fdId: "category-1" } };
    const updatePayload = { fdId: "created-1", fdName: "MK_TEST_示例" };

    await client.login(credentials);
    const initialized = await client.initTemplate();
    const tableName = await client.generateTableName();
    const category = await client.loadParentCategory("category-1");
    const created = await client.addTemplate(addPayload);
    const detail = await client.getTemplate("created-1");
    const updated = await client.updateTemplate(updatePayload);

    assert.equal(responses.length, 0);
    assert.deepEqual(calls.map((call) => call.url), [
      `${NEWOA_SIT_BASE_URL}/data/sys-auth/login`,
      `${NEWOA_SIT_BASE_URL}/data/km-review/kmReviewTemplate/init`,
      `${NEWOA_SIT_BASE_URL}/data/km-review/kmReviewTemplate/generateTableName`,
      `${NEWOA_SIT_BASE_URL}/data/km-review/kmReviewCategory/loadParentCategoryVO`,
      `${NEWOA_SIT_BASE_URL}/data/km-review/kmReviewTemplate/add`,
      `${NEWOA_SIT_BASE_URL}/data/km-review/kmReviewTemplate/get`,
      `${NEWOA_SIT_BASE_URL}/data/km-review/kmReviewTemplate/update`
    ]);
    assert.equal(calls.every((call) => call.options.method === "POST"), true);

    const login = calls[0].options;
    assert.equal(login.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(login.headers.origin, NEWOA_SIT_BASE_URL);
    assert.equal(login.headers.referer, `${NEWOA_SIT_BASE_URL}/web/`);
    assert.equal(login.body instanceof URLSearchParams, true);
    assert.equal(login.body.get("j_username"), credentials.username);
    assert.equal(login.body.get("j_password"), credentials.encryptedPassword);

    for (const call of calls.slice(1)) {
      assert.equal(call.options.headers["content-type"], "application/json");
      assert.equal(call.options.headers.cookie, "JSESSIONID=session-1; route=node-a");
      assert.equal(call.options.headers.Authorization, "Bearer token-1");
    }
    assert.deepEqual(calls.slice(1).map((call) => JSON.parse(call.options.body)), [
      {},
      {},
      { fdId: "category-1" },
      addPayload,
      { fdId: "created-1", mechanisms: { load: "*" } },
      updatePayload
    ]);
    assert.deepEqual(initialized, { fdId: "init-1" });
    assert.equal(tableName, "mk_table_1");
    assert.deepEqual(category, { fdFormCategoryId: "category-1", fdName: "测试分类" });
    assert.deepEqual(created, { id: "created-1", fdName: "MK_TEST_示例", fdId: "created-1" });
    assert.deepEqual(detail, { fdId: "created-1", fdName: "MK_TEST_示例" });
    assert.deepEqual(updated, { fdId: "created-1" });
  });

  it("reports stable stages for injected-fetch failures", async () => {
    const loginClient = new NewoaClient({
      fetchImpl: async () => jsonResponse({ success: false, msg: "denied" }, { status: 401 })
    });
    await assert.rejects(
      () => loginClient.login({ username: "contract-user", encryptedPassword: "contract-password" }),
      (error) => {
        assert.equal(error.stage, "login");
        assert.equal(error.message, "NewOA login failed: denied");
        assert.deepEqual(error.response, {
          status: 401,
          body: { success: false, msg: "denied" }
        });
        return true;
      }
    );

    const apiClient = new NewoaClient({
      fetchImpl: async () => jsonResponse({ success: false, msg: "broken" })
    });
    await assert.rejects(
      () => apiClient.initTemplate(),
      (error) => {
        assert.equal(error.stage, "kmReviewTemplate/init");
        assert.equal(error.message, "NewOA API kmReviewTemplate/init failed: broken");
        return true;
      }
    );
  });

  it("accepts only the NewOA SIT origin at the execution safety seam", () => {
    assert.equal(assertAllowedBaseUrl(`${NEWOA_SIT_BASE_URL}/`), NEWOA_SIT_BASE_URL);
    assert.throws(
      () => assertAllowedBaseUrl("https://p.onewo.com"),
      /locked to https:\/\/p-sit\.onewo\.com/
    );
  });
});

function jsonResponse(body, options = {}) {
  const status = options.status ?? 200;
  const headers = new Headers();
  for (const cookie of options.cookies || []) headers.append("set-cookie", cookie);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => JSON.stringify(body)
  };
}
