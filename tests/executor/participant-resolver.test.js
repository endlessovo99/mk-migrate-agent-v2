import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeDsl } from "../../src/executor/execute.js";
import { NewoaClient, NEWOA_SIT_BASE_URL } from "../../src/executor/newoa-client.js";
import {
  ParticipantResolutionError,
  resolveWorkflowParticipants
} from "../../src/executor/participant-resolver.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { localCorpusIt } from "../helpers/local-corpus.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

const SIT_FALLBACK_PARTICIPANT_ID = "1j8mu7vviw1owgp04w2v4p47v1rmcohi3tw0";

describe("resolveWorkflowParticipants", () => {
  it("uses the validated SIT fallback for source identities that cannot be found", async () => {
    const dsl = dslWithExplicitMembers([
      sourceMember({
        name: "不存在岗位",
        sourceId: "legacy-post-missing",
        sourceOrgType: 4,
        sourceParentName: "采购部"
      }),
      sourceMember({
        name: "部门领导",
        sourceId: "legacy-role-without-parent",
        sourceOrgType: 32,
        sourceParentName: undefined
      })
    ]);
    const client = new SearchClient({
      不存在岗位: []
    }, {
      [SIT_FALLBACK_PARTICIPANT_ID]: [currentOrg({
        fdId: SIT_FALLBACK_PARTICIPANT_ID,
        fdName: "SIT 临时审批人",
        fdOrgType: 8
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      targetBaseUrl: NEWOA_SIT_BASE_URL
    });

    assert.deepEqual(
      result.dsl.workflow.nodes[1].participants.members.map(({ id, name, targetOrgType }) => ({
        id,
        name,
        targetOrgType
      })),
      [
        { id: SIT_FALLBACK_PARTICIPANT_ID, name: "SIT 临时审批人", targetOrgType: 8 }
      ]
    );
    assert.equal(result.fallbackCount, 2);
    assert.equal(result.fallbackIdentityCount, 2);
    assert.equal(result.fallbackTargetId, SIT_FALLBACK_PARTICIPANT_ID);
    assert.deepEqual(client.calls, ["不存在岗位"]);
    assert.deepEqual(client.elementCalls, [[SIT_FALLBACK_PARTICIPANT_ID]]);
  });

  it("does not partially apply the SIT fallback when another identity is ambiguous", async () => {
    const dsl = dslWithExplicitMembers([
      sourceMember({
        name: "不存在岗位",
        sourceId: "legacy-post-missing",
        sourceOrgType: 4,
        sourceParentName: "采购部"
      }),
      sourceMember({
        name: "重复岗位",
        sourceId: "legacy-post-ambiguous",
        sourceOrgType: 4,
        sourceParentName: "采购部"
      })
    ]);
    const client = new SearchClient({
      不存在岗位: [],
      重复岗位: [
        currentOrg({ fdId: "post-a", fdName: "重复岗位", fdOrgType: 4, fdParentName: "采购部" }),
        currentOrg({ fdId: "post-b", fdName: "重复岗位", fdOrgType: 4, fdParentName: "采购部" })
      ]
    }, {
      [SIT_FALLBACK_PARTICIPANT_ID]: [currentOrg({
        fdId: SIT_FALLBACK_PARTICIPANT_ID,
        fdName: "SIT 临时审批人",
        fdOrgType: 8
      })]
    });

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        targetBaseUrl: NEWOA_SIT_BASE_URL
      }),
      (error) => {
        assert.equal(error instanceof ParticipantResolutionError, true);
        assert.deepEqual(error.issues.map((issue) => issue.reason), ["not_found", "ambiguous"]);
        return true;
      }
    );
    assert.deepEqual(client.elementCalls, []);
  });

  it("keeps unresolved identities blocking outside the exact NewOA SIT origin", async () => {
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "不存在岗位",
      sourceId: "legacy-post-missing",
      sourceOrgType: 4,
      sourceParentName: "采购部"
    })]);
    const client = new SearchClient({ 不存在岗位: [] }, {
      [SIT_FALLBACK_PARTICIPANT_ID]: [currentOrg({
        fdId: SIT_FALLBACK_PARTICIPANT_ID,
        fdName: "SIT 临时审批人",
        fdOrgType: 8
      })]
    });

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        targetBaseUrl: "https://p-sit.onewo.com:8443"
      }),
      (error) => {
        assert.deepEqual(error.issues.map((issue) => issue.reason), ["not_found"]);
        return true;
      }
    );
    assert.deepEqual(client.elementCalls, []);
  });

  it("requires the configured SIT fallback fdId to resolve to a current person", async () => {
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "不存在岗位",
      sourceId: "legacy-post-missing",
      sourceOrgType: 4,
      sourceParentName: "采购部"
    })]);
    const client = new SearchClient({ 不存在岗位: [] }, {
      [SIT_FALLBACK_PARTICIPANT_ID]: [currentOrg({
        fdId: SIT_FALLBACK_PARTICIPANT_ID,
        fdName: "错误的岗位目标",
        fdOrgType: 4
      })]
    });

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        targetBaseUrl: NEWOA_SIT_BASE_URL
      }),
      (error) => {
        assert.deepEqual(error.issues.map((issue) => issue.reason), ["fallback_target_not_person"]);
        return true;
      }
    );
  });

  it("does not hide malformed source identities behind the SIT fallback", async () => {
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "",
      sourceId: "legacy-person-without-name",
      sourceOrgType: 8,
      sourceParentName: "采购部"
    })]);
    const client = new SearchClient({}, {
      [SIT_FALLBACK_PARTICIPANT_ID]: [currentOrg({
        fdId: SIT_FALLBACK_PARTICIPANT_ID,
        fdName: "SIT 临时审批人",
        fdOrgType: 8
      })]
    });

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        targetBaseUrl: NEWOA_SIT_BASE_URL
      }),
      (error) => {
        assert.deepEqual(error.issues.map((issue) => issue.reason), ["missing_source_evidence"]);
        assert.deepEqual(error.issues[0].missing, ["name"]);
        return true;
      }
    );
    assert.deepEqual(client.elementCalls, []);
  });

  it("does not treat organization API failures as SIT not-found results", async () => {
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "查询失败的审批人",
      sourceId: "legacy-search-failure",
      sourceOrgType: 8,
      sourceParentName: "采购部"
    })]);
    const client = new SearchClient({}, {
      [SIT_FALLBACK_PARTICIPANT_ID]: [currentOrg({
        fdId: SIT_FALLBACK_PARTICIPANT_ID,
        fdName: "SIT 临时审批人",
        fdOrgType: 8
      })]
    });
    client.searchOrg = async () => {
      throw new Error("organization API unavailable");
    };

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        targetBaseUrl: NEWOA_SIT_BASE_URL
      }),
      (error) => {
        assert.deepEqual(error.issues.map((issue) => issue.reason), ["search_failed"]);
        return true;
      }
    );
    assert.deepEqual(client.elementCalls, []);
  });

  it("resolves explicit people and posts from current NewOA evidence and caches repeated identities", async () => {
    const dsl = dslWithExplicitMembers([
      sourceMember({
        name: "张三",
        sourceId: "legacy-person-1",
        sourceOrgType: 8,
        sourceParentName: "财务部",
        sourceLoginName: "zhangsan"
      }),
      sourceMember({
        name: "采购岗",
        sourceId: "legacy-post-1",
        sourceOrgType: 4,
        sourceParentName: "采购部"
      }),
      sourceMember({
        name: "张三",
        sourceId: "legacy-person-1",
        sourceOrgType: 8,
        sourceParentName: "财务部",
        sourceLoginName: "zhangsan"
      })
    ]);
    dsl.workflow.nodes[1].participants.alternativeMembers = [sourceMember({
      name: "王五",
      sourceId: "legacy-person-alternative",
      sourceOrgType: 8,
      sourceParentName: "采购部",
      sourceLoginName: "wangwu"
    })];
    dsl.workflow.nodes[1].participants.useAlternativeOnly = true;
    const client = new SearchClient({
      zhangsan: [
        currentOrg({ fdId: "new-person-wrong", fdName: "张三", fdOrgType: 8, fdParentName: "财务部", fdLoginName: "other" }),
        currentOrg({ fdId: "new-person-1", fdName: "张三（现用名）", fdOrgType: 8, fdParentName: "新财务部", fdLoginName: "zhangsan" })
      ],
      采购岗: [
        currentOrg({ fdId: "new-post-wrong-parent", fdName: "采购岗", fdOrgType: 4, fdParentName: "华南采购部" }),
        currentOrg({ fdId: "new-post-1", fdName: "采购岗", fdOrgType: 4, fdParentName: "采购部" }),
        currentOrg({ fdId: "new-post-wrong-type", fdName: "采购岗", fdOrgType: 8, fdParentName: "采购部" })
      ],
      wangwu: [
        currentOrg({ fdId: "new-person-alternative", fdName: "王五", fdOrgType: 8, fdParentName: "采购部", fdLoginName: "wangwu" })
      ]
    });

    const result = await resolveWorkflowParticipants(dsl, { client });
    const members = result.dsl.workflow.nodes[1].participants.members;

    assert.deepEqual(members.map(({ id, name, targetOrgType }) => ({ id, name, targetOrgType })), [
      { id: "new-person-1", name: "张三（现用名）", targetOrgType: 8 },
      { id: "new-post-1", name: "采购岗", targetOrgType: 4 }
    ]);
    assert.deepEqual(members.map((member) => member.sourceId), [
      "legacy-person-1",
      "legacy-post-1"
    ]);
    assert.deepEqual(
      result.dsl.workflow.nodes[1].participants.alternativeMembers.map(({ id, name, targetOrgType }) => ({ id, name, targetOrgType })),
      [{ id: "new-person-alternative", name: "王五", targetOrgType: 8 }]
    );
    assert.equal(result.dsl.workflow.nodes[1].participants.useAlternativeOnly, true);
    assert.equal(result.resolvedCount, 4);
    assert.equal(result.identityCount, 3);
    assert.deepEqual(client.calls, ["zhangsan", "采购岗", "wangwu"]);
    assert.equal(dsl.workflow.nodes[1].participants.members[0].id, undefined);
  });

  it("falls back to exact person name, parent, and org type when no login name is available", async () => {
    const dsl = dslWithExplicitMembers([
      sourceMember({
        name: "李四",
        sourceId: "legacy-person-2",
        sourceOrgType: 8,
        sourceParentName: "法务部"
      })
    ]);
    const client = new SearchClient({
      李四: [
        currentOrg({ fdId: "wrong-parent", fdName: "李四", fdOrgType: 8, fdParentName: "财务部" }),
        currentOrg({ fdId: "new-person-2", fdName: "李四", fdOrgType: "8", fdParentName: "法务部" })
      ]
    });

    const result = await resolveWorkflowParticipants(dsl, { client });

    assert.equal(result.dsl.workflow.nodes[1].participants.members[0].id, "new-person-2");
    assert.equal(result.dsl.workflow.nodes[1].participants.members[0].targetOrgType, "8");
  });

  it("falls back from a login-key search to a name search and matches fdNo", async () => {
    const dsl = dslWithExplicitMembers([
      sourceMember({
        name: "赵六",
        sourceId: "legacy-person-3",
        sourceOrgType: 8,
        sourceParentName: "运营部",
        sourceLoginName: "P0006"
      })
    ]);
    const client = new SearchClient({
      P0006: [],
      赵六: [
        currentOrg({ fdId: "new-person-3", fdName: "赵六", fdOrgType: 8, fdParentName: "运营部", fdNo: "P0006" })
      ]
    });

    const result = await resolveWorkflowParticipants(dsl, { client });

    assert.equal(result.dsl.workflow.nodes[1].participants.members[0].id, "new-person-3");
    assert.deepEqual(client.calls, ["P0006", "赵六"]);
  });

  it("validates already target-shaped ids against current NewOA before preserving them", async () => {
    const dsl = dslWithExplicitMembers([
      { id: "current-target-id", name: "已解析审批人", type: "user_or_org" },
      { id: "current-target-id", name: "重复引用", type: "user_or_org" }
    ]);
    const client = new SearchClient({}, {
      "current-target-id": [currentOrg({
        fdId: "current-target-id",
        fdName: "已解析审批人",
        fdOrgType: 8
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, { client });

    assert.equal(result.dsl.workflow.nodes[1].participants.members[0].id, "current-target-id");
    assert.deepEqual(
      result.dsl.workflow.nodes[1].participants.members.map((member) => member.targetOrgType),
      [8]
    );
    assert.equal(result.identityCount, 1);
    assert.equal(result.resolvedCount, 0);
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [["current-target-id"]]);
  });

  it("requires exact name, parent, and type for other organization kinds", async () => {
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "区域角色",
      sourceId: "legacy-role-1",
      sourceOrgType: 32,
      sourceParentName: "华南区域"
    })]);
    const client = new SearchClient({
      区域角色: [
        currentOrg({ fdId: "wrong-role-type", fdName: "区域角色", fdOrgType: 4, fdParentName: "华南区域" }),
        currentOrg({ fdId: "current-role-1", fdName: "区域角色", fdOrgType: 32, fdParentName: "华南区域" })
      ]
    });

    const result = await resolveWorkflowParticipants(dsl, { client });

    assert.equal(result.dsl.workflow.nodes[1].participants.members[0].id, "current-role-1");
    assert.equal(result.dsl.workflow.nodes[1].participants.members[0].targetOrgType, 32);
  });

  it("aggregates missing and ambiguous identities instead of trusting legacy ids", async () => {
    const dsl = dslWithExplicitMembers([
      sourceMember({
        id: "0123456789abcdef0123456789abcdef",
        name: "不存在岗位",
        sourceId: "legacy-post-missing",
        sourceOrgType: 4,
        sourceParentName: "采购部"
      }),
      sourceMember({
        id: "fedcba9876543210fedcba9876543210",
        name: "重复岗位",
        sourceId: "legacy-post-ambiguous",
        sourceOrgType: 4,
        sourceParentName: "采购部"
      }),
      {
        id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        name: "缺少来源证据",
        type: "user_or_org"
      }
    ]);
    const client = new SearchClient({
      不存在岗位: [],
      重复岗位: [
        currentOrg({ fdId: "post-a", fdName: "重复岗位", fdOrgType: 4, fdParentName: "采购部" }),
        currentOrg({ fdId: "post-b", fdName: "重复岗位", fdOrgType: 4, fdParentName: "采购部" })
      ]
    });

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, { client }),
      (error) => {
        assert.equal(error instanceof ParticipantResolutionError, true);
        assert.equal(error.stage, "resolveWorkflowParticipants");
        assert.equal(error.code, "workflow.participant_resolution_failed");
        assert.deepEqual(error.issues.map((issue) => issue.reason), ["not_found", "ambiguous", "not_found"]);
        assert.equal(error.message.includes("3 explicit workflow participant identities"), true);
        return true;
      }
    );
    assert.equal(dsl.workflow.nodes[1].participants.members[0].id, "0123456789abcdef0123456789abcdef");
    assert.deepEqual(client.calls, ["不存在岗位", "重复岗位"]);
    assert.deepEqual(client.elementCalls, [["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]]);
  });

  localCorpusIt("replaces every unresolved source 167 participant reference on NewOA SIT", async () => {
    const dsl = draftSourceDraft(cleanSourceFile(
      "tests/fixtures/source/1670297c984b45009eb5b1e444d9957d"
    ));
    const sourceReferenceCount = dsl.workflow.nodes.reduce((count, node) => (
      count +
      (node.participants?.members || []).length +
      (node.participants?.alternativeMembers || []).length
    ), 0);
    const client = new SearchClient({}, {
      [SIT_FALLBACK_PARTICIPANT_ID]: [currentOrg({
        fdId: SIT_FALLBACK_PARTICIPANT_ID,
        fdName: "SIT 临时审批人",
        fdOrgType: 8
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      targetBaseUrl: NEWOA_SIT_BASE_URL
    });
    const collections = result.dsl.workflow.nodes.flatMap((node) => [
      node.participants?.members,
      node.participants?.alternativeMembers
    ]).filter(Array.isArray);
    const references = collections.flat();
    const n210 = result.dsl.workflow.nodes.find((node) => node.id === "N210");
    const n378 = result.dsl.workflow.nodes.find((node) => node.id === "N378");
    assert.equal(result.identityCount, 57);
    assert.equal(result.fallbackIdentityCount, 57);
    assert.equal(result.fallbackCount, 326);
    assert.equal(sourceReferenceCount, 326);
    assert.equal(references.every((member) => member.id === SIT_FALLBACK_PARTICIPANT_ID), true);
    assert.equal(collections.every((members) => (
      new Set(members.map((member) => member.id)).size === members.length
    )), true);
    assert.equal(n210.participants.members.length, 1);
    assert.equal(n378.participants.alternativeMembers.length, 1);
    assert.deepEqual(client.elementCalls, [[SIT_FALLBACK_PARTICIPANT_ID]]);
  });
});

describe("executeDsl participant resolution seam", () => {
  it("reports and persists the temporary participant fallback on NewOA SIT", async () => {
    const dsl = dslWithExplicitMembers([
      sourceMember({
        name: "当前 SIT 不存在的审批人",
        sourceId: "legacy-person-not-in-sit",
        sourceOrgType: 8,
        sourceParentName: "源系统部门"
      })
    ]);
    dsl.workflow.nodes[1].attributes = {
      handlerIds: "legacy-person-not-in-sit",
      handlerNames: "当前 SIT 不存在的审批人",
      handlerSelectType: "org"
    };
    const client = new CompleteSearchClient({}, {
      [SIT_FALLBACK_PARTICIPANT_ID]: [currentOrg({
        fdId: SIT_FALLBACK_PARTICIPANT_ID,
        fdName: "SIT 临时审批人",
        fdOrgType: 8
      })]
    });

    const result = await executeDsl(dsl, {
      client,
      credentials: { username: "route-user", encryptedPassword: "route-password" },
      confirmWrite: true,
      targetCategoryId: "category-1",
      baseUrl: NEWOA_SIT_BASE_URL,
      now: new Date("2026-07-10T10:00:00.000Z")
    });
    const workflow = JSON.parse(client.savedTemplate.mechanisms.lbpmTemplate[0].fdContent);
    const reviewNode = workflow.elements.find((element) => element.id === "N-review");
    const members = reviewNode.handlers.members;
    const stage = result.apiStages.find((item) => item.name === "resolveWorkflowParticipants");

    assert.equal(result.ok, true);
    assert.equal(result.status, "written_with_warnings");
    assert.deepEqual(members, [{
      id: SIT_FALLBACK_PARTICIPANT_ID,
      name: "SIT 临时审批人",
      element: "user",
      type: "1"
    }]);
    assert.equal(reviewNode.handlerIds, SIT_FALLBACK_PARTICIPANT_ID);
    assert.equal(reviewNode.handlerNames, "SIT 临时审批人");
    assert.equal(JSON.stringify(reviewNode.handlers).includes("legacy-person-not-in-sit"), false);
    assert.equal(stage.fallbackCount, 1);
    assert.equal(stage.fallbackIdentityCount, 1);
    assert.equal(stage.fallbackTargetId, SIT_FALLBACK_PARTICIPANT_ID);
    assert.equal(
      result.diagnostics.some((item) => item.code === "workflow.participant_sit_fallback_applied"),
      true
    );
  });

  it("projects current NewOA participant ids instead of the source ids", async () => {
    const dsl = dslWithExplicitMembers([
      sourceMember({
        name: "采购岗",
        sourceId: "0123456789abcdef0123456789abcdef",
        sourceOrgType: 4,
        sourceParentName: "采购部"
      })
    ]);
    const client = new CompleteSearchClient({
      采购岗: [currentOrg({ fdId: "current-post-1", fdName: "采购岗", fdOrgType: 4, fdParentName: "采购部" })]
    });

    const result = await executeDsl(dsl, {
      client,
      credentials: { username: "route-user", encryptedPassword: "route-password" },
      confirmWrite: true,
      targetCategoryId: "category-1",
      now: new Date("2026-07-10T10:00:00.000Z")
    });
    const workflow = JSON.parse(client.savedTemplate.mechanisms.lbpmTemplate[0].fdContent);
    const members = workflow.elements.find((element) => element.id === "N-review").handlers.members;

    assert.equal(result.ok, true);
    assert.deepEqual(members.map((member) => member.id), ["current-post-1"]);
    assert.equal(JSON.stringify(members).includes("0123456789abcdef0123456789abcdef"), false);
    assert.deepEqual(result.apiStages.find((stage) => stage.name === "resolveWorkflowParticipants"), {
      name: "resolveWorkflowParticipants",
      status: "ok",
      resolvedCount: 1,
      identityCount: 1
    });
  });

  it("stops after login and read-only org search when an identity is ambiguous", async () => {
    const dsl = dslWithExplicitMembers([
      sourceMember({
        name: "重复岗位",
        sourceId: "legacy-post-ambiguous",
        sourceOrgType: 4,
        sourceParentName: "采购部"
      })
    ]);
    const client = new SearchClient({
      重复岗位: [
        currentOrg({ fdId: "post-a", fdName: "重复岗位", fdOrgType: 4, fdParentName: "采购部" }),
        currentOrg({ fdId: "post-b", fdName: "重复岗位", fdOrgType: 4, fdParentName: "采购部" })
      ]
    });

    const result = await executeDsl(dsl, {
      client,
      credentials: { username: "route-user", encryptedPassword: "route-password" },
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, false);
    assert.equal(result.stage, "resolveWorkflowParticipants");
    assert.deepEqual(result.createdFdIds, []);
    assert.deepEqual(client.executeCalls, ["login"]);
    assert.deepEqual(client.calls, ["重复岗位"]);
    assert.equal(result.apiStages.find((stage) => stage.name === "resolveWorkflowParticipants").status, "failed");
    assert.equal(result.apiStages.some((stage) => stage.name === "init"), false);
    assert.equal(result.apiStages.some((stage) => stage.name === "add"), false);
    assert.equal(result.diagnostics.at(-1).code, "workflow.participant_resolution_failed");
    assert.equal(result.diagnostics.at(-1).path, "/workflow/participants");
    assert.deepEqual(result.diagnostics.at(-1).details.issues.map((issue) => issue.reason), ["ambiguous"]);
  });
});

describe("NewoaClient current organization reads", () => {
  it("uses the current read-only NewOA address search contract", async () => {
    const calls = [];
    const client = new NewoaClient({
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({
          success: true,
          data: [currentOrg({ fdId: "person-1", fdName: "张三", fdOrgType: 8, fdParentName: "财务部" })]
        });
      }
    });

    const result = await client.searchOrg("张三");

    assert.equal(calls[0].url, `${NEWOA_SIT_BASE_URL}/data/sys-org/sysOrgAddress/searchOrg`);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      key: "张三",
      orgType: 287,
      paramAvailable: 1,
      searchMode: "ACCURATE"
    });
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(result.map((item) => item.fdId), ["person-1"]);
  });

  it("validates existing targets with the current element-info contract", async () => {
    const calls = [];
    const client = new NewoaClient({
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({
          success: true,
          data: [currentOrg({ fdId: "current-target-id", fdName: "审批人", fdOrgType: 8 })]
        });
      }
    });

    const result = await client.getElementInfo(["current-target-id"]);

    assert.equal(calls[0].url, `${NEWOA_SIT_BASE_URL}/data/sys-org/sysOrgElementQuery/getElementInfo`);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      targets: ["current-target-id"],
      colums: ["fdId", "fdName", "fdOrgType"]
    });
    assert.deepEqual(result.map((item) => item.fdId), ["current-target-id"]);
  });
});

class SearchClient {
  constructor(results = {}, elementResults = {}) {
    this.results = results;
    this.elementResults = elementResults;
    this.calls = [];
    this.elementCalls = [];
    this.executeCalls = [];
  }

  async login() {
    this.executeCalls.push("login");
    return { ok: true };
  }

  async searchOrg(name) {
    this.calls.push(name);
    return structuredClone(this.results[name] || []);
  }

  async getElementInfo(targets) {
    this.elementCalls.push(structuredClone(targets));
    return structuredClone(this.elementResults[targets[0]] || []);
  }
}

class CompleteSearchClient extends SearchClient {
  async initTemplate() {
    this.executeCalls.push("initTemplate");
    return {
      fdId: "init-template-id",
      fdName: "初始化模板",
      fdCode: "template_base",
      fdStatus: 0,
      mechanisms: {
        "sys-xform": { fdId: "init-template-id", fdName: "初始化模板", fdConfig: "{}" },
        lbpmTemplate: [{ fdTemplateForms: [] }]
      }
    };
  }

  async generateTableName() {
    this.executeCalls.push("generateTableName");
    return "generated_table_name";
  }

  async loadParentCategory(fdId) {
    this.executeCalls.push("loadParentCategory");
    return { fdFormCategoryId: fdId, fdName: "测试分类" };
  }

  async addTemplate(payload) {
    this.executeCalls.push("addTemplate");
    return { fdId: "created-template-id", fdName: payload.fdName };
  }

  async getTemplate(fdId) {
    this.executeCalls.push("getTemplate");
    return this.savedTemplate || {
      fdId,
      fdName: "created",
      mechanisms: {
        "sys-xform": { fdId, fdName: "created", fdConfig: "{}" },
        lbpmTemplate: [{
          fdId: "lbpm-template-id",
          fdName: "created",
          fdTemplateCode: "template_created",
          fdEntityId: fdId,
          fdEntityKey: "KmReviewMain",
          fdEntityName: "com.landray.km.review.core.entity.KmReviewTemplate",
          fdMainEntityName: "com.landray.km.review.core.entity.KmReviewMain",
          fdModuleCode: "km-review",
          fdTemplateForms: [],
          fdContent: "{}"
        }]
      }
    };
  }

  async updateTemplate(payload) {
    this.executeCalls.push("updateTemplate");
    this.savedTemplate = payload;
    return { fdId: payload.fdId };
  }

  async saveWorkflowDraft(payload) {
    this.executeCalls.push("saveWorkflowDraft");
    this.savedWorkflowDraft = payload;
    return { fdId: payload.fdId };
  }

  async getWorkflowTemplateDetail() {
    this.executeCalls.push("getWorkflowTemplateDetail");
    return {
      ...this.savedWorkflowDraft,
      isDraft: true,
      fdStatus: "draft"
    };
  }
}

function dslWithExplicitMembers(members) {
  const dsl = sampleTrustedDsl();
  dsl.workflow.nodes.splice(1, 0, {
    id: "N-review",
    type: "review",
    element: "manualTask",
    name: "审批",
    sourceType: "reviewNode",
    sourceRef: "source.workflow.node.N-review",
    attributes: {},
    participants: { mode: "explicit", members },
    translationStatus: "executable"
  });
  dsl.workflow.edges = [
    {
      id: "L1",
      source: "N1",
      target: "N-review",
      sourceRef: "source.workflow.edge.L1",
      condition: { translationStatus: "executable" }
    },
    {
      id: "L2",
      source: "N-review",
      target: "N2",
      sourceRef: "source.workflow.edge.L2",
      condition: { translationStatus: "executable" }
    }
  ];
  dsl.workflow.topologicalOrder = ["N1", "N-review", "N2"];
  return dsl;
}

function sourceMember(overrides = {}) {
  return {
    name: "审批人",
    type: "user_or_org",
    sourceId: "legacy-id",
    sourceOrgType: 8,
    sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgPerson",
    sourceParentName: "审批部",
    ...overrides
  };
}

function currentOrg(overrides = {}) {
  return {
    fdId: "current-id",
    fdName: "审批人",
    fdOrgType: 8,
    fdParentName: "审批部",
    ...overrides
  };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify(body)
  };
}
