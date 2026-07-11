import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NewoaClient,
  NEWOA_SIT_BASE_URL,
  normalizeBaseUrl
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
      jsonResponse({ success: true, data: { fdId: "created-1" } }),
      jsonResponse({ success: true, data: { fdId: "lbpm-template-1" } }),
      jsonResponse({
        success: true,
        data: {
          fdId: "lbpm-template-1",
          isDraft: true,
          fdStatus: "draft",
          fdContent: "{\"elements\":[]}"
        }
      })
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
    const workflowDraftPayload = {
      fdId: "lbpm-template-1",
      fdContent: "{\"elements\":[]}",
      isDraft: true
    };
    const savedWorkflowDraft = await client.saveWorkflowDraft(workflowDraftPayload);
    const workflowDetail = await client.getWorkflowTemplateDetail({
      templateId: "lbpm-template-1",
      definitionId: ""
    });

    assert.equal(responses.length, 0);
    assert.deepEqual(calls.map((call) => call.url), [
      `${NEWOA_SIT_BASE_URL}/data/sys-auth/login`,
      `${NEWOA_SIT_BASE_URL}/data/km-review/kmReviewTemplate/init`,
      `${NEWOA_SIT_BASE_URL}/data/km-review/kmReviewTemplate/generateTableName`,
      `${NEWOA_SIT_BASE_URL}/data/km-review/kmReviewCategory/loadParentCategoryVO`,
      `${NEWOA_SIT_BASE_URL}/data/km-review/kmReviewTemplate/add`,
      `${NEWOA_SIT_BASE_URL}/data/km-review/kmReviewTemplate/get`,
      `${NEWOA_SIT_BASE_URL}/data/km-review/kmReviewTemplate/update`,
      `${NEWOA_SIT_BASE_URL}/data/sys-lbpm/lbpmTemplate/publish`,
      `${NEWOA_SIT_BASE_URL}/data/sys-lbpm/lbpmTemplate/details`
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
      updatePayload,
      workflowDraftPayload,
      { templateId: "lbpm-template-1", definitionId: "" }
    ]);
    assert.deepEqual(initialized, { fdId: "init-1" });
    assert.equal(tableName, "mk_table_1");
    assert.deepEqual(category, { fdFormCategoryId: "category-1", fdName: "测试分类" });
    assert.deepEqual(created, { id: "created-1", fdName: "MK_TEST_示例", fdId: "created-1" });
    assert.deepEqual(detail, { fdId: "created-1", fdName: "MK_TEST_示例" });
    assert.deepEqual(updated, { fdId: "created-1" });
    assert.deepEqual(savedWorkflowDraft, { fdId: "lbpm-template-1" });
    assert.deepEqual(workflowDetail, {
      fdId: "lbpm-template-1",
      isDraft: true,
      fdStatus: "draft",
      fdContent: "{\"elements\":[]}"
    });
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

    const workflowDraftClient = new NewoaClient({
      fetchImpl: async () => jsonResponse({ success: false, msg: "draft broken" })
    });
    await assert.rejects(
      () => workflowDraftClient.saveWorkflowDraft({ fdId: "lbpm-1", fdContent: "{}", isDraft: true }),
      (error) => {
        assert.equal(error.stage, "saveWorkflowDraft");
        return true;
      }
    );

    const workflowDetailClient = new NewoaClient({
      fetchImpl: async () => jsonResponse({ success: false, msg: "detail broken" })
    });
    await assert.rejects(
      () => workflowDetailClient.getWorkflowTemplateDetail({ templateId: "lbpm-1", definitionId: "definition-1" }),
      (error) => {
        assert.equal(error.stage, "getWorkflowTemplateDetail");
        return true;
      }
    );
  });

  it("refuses publish mode at the workflow draft boundary", async () => {
    let fetchCalled = false;
    const client = new NewoaClient({
      fetchImpl: async () => {
        fetchCalled = true;
        return jsonResponse({ success: true, data: {} });
      }
    });

    await assert.rejects(
      () => client.saveWorkflowDraft({ fdId: "lbpm-1", fdContent: "{}", isDraft: false }),
      (error) => {
        assert.equal(error.stage, "saveWorkflowDraft");
        return true;
      }
    );
    assert.equal(fetchCalled, false);
  });

  it("accepts a configured HTTPS root origin at the execution safety seam", () => {
    assert.equal(normalizeBaseUrl("https://p.onewo.com"), "https://p.onewo.com");
  });

  it("uses the SIT origin when the configured base URL is blank", () => {
    assert.equal(normalizeBaseUrl("   "), NEWOA_SIT_BASE_URL);
  });

  it("normalizes surrounding whitespace and a trailing slash to the canonical origin", () => {
    assert.equal(normalizeBaseUrl("  HTTP://Example.COM:80/  "), "http://example.com");
  });

  it("accepts HTTP root origins using domain, localhost, IP, and explicit port hosts", () => {
    assert.deepEqual(
      [
        "http://oa.example.com",
        "http://localhost:3000/",
        "http://127.0.0.1:8080/"
      ].map(normalizeBaseUrl),
      [
        "http://oa.example.com",
        "http://localhost:3000",
        "http://127.0.0.1:8080"
      ]
    );
  });

  it("uses the canonical configured origin for client requests", async () => {
    let requestUrl;
    const client = new NewoaClient({
      baseUrl: "  HTTP://LOCALHOST:8080/  ",
      fetchImpl: async (url) => {
        requestUrl = url;
        return jsonResponse({ success: true, data: { fdId: "init-1" } });
      }
    });

    await client.initTemplate();

    assert.equal(requestUrl, "http://localhost:8080/data/km-review/kmReviewTemplate/init");
  });

  it("rejects a base URL with a non-root path", () => {
    assert.throws(
      () => normalizeBaseUrl("https://oa.example.com/api"),
      /root HTTP\(S\) origin/
    );
  });

  it("rejects a path that URL parsing would otherwise resolve to root", () => {
    assert.throws(
      () => normalizeBaseUrl("https://oa.example.com/."),
      /root HTTP\(S\) origin/
    );
  });

  it("rejects a base URL with a query", () => {
    assert.throws(
      () => normalizeBaseUrl("https://oa.example.com?tenant=test"),
      /root HTTP\(S\) origin/
    );
  });

  it("rejects a base URL with an empty query marker", () => {
    assert.throws(
      () => normalizeBaseUrl("https://oa.example.com?"),
      /root HTTP\(S\) origin/
    );
  });

  it("rejects a base URL with a fragment", () => {
    assert.throws(
      () => normalizeBaseUrl("https://oa.example.com#login"),
      /root HTTP\(S\) origin/
    );
  });

  it("rejects a base URL with user information", () => {
    assert.throws(
      () => normalizeBaseUrl("https://user:password@oa.example.com"),
      /root HTTP\(S\) origin/
    );
  });

  it("rejects a base URL with empty user information", () => {
    for (const value of ["https://@oa.example.com", "https://:@oa.example.com"]) {
      assert.throws(
        () => normalizeBaseUrl(value),
        /root HTTP\(S\) origin/
      );
    }
  });

  it("rejects a base URL with a non-HTTP protocol", () => {
    assert.throws(
      () => normalizeBaseUrl("ftp://oa.example.com"),
      /root HTTP\(S\) origin/
    );
  });

  it("rejects a malformed base URL", () => {
    assert.throws(
      () => normalizeBaseUrl("not a URL"),
      /root HTTP\(S\) origin/
    );
  });

  it("rejects a URL without an explicit authority delimiter", () => {
    assert.throws(
      () => normalizeBaseUrl("https:oa.example.com"),
      /root HTTP\(S\) origin/
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
