import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeDsl } from "../../src/executor/execute.js";
import { NewoaClient, NEWOA_SIT_BASE_URL } from "../../src/executor/newoa-client.js";
import {
  ParticipantResolutionError,
  resolveWorkflowParticipants
} from "../../src/executor/participant-resolver.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("resolveWorkflowParticipants", () => {
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
      张三: [
        currentOrg({ fdId: "new-person-wrong", fdName: "张三", fdOrgType: 8, fdParentName: "财务部", fdLoginName: "other" }),
        currentOrg({ fdId: "new-person-1", fdName: "张三（现用名）", fdOrgType: 8, fdParentName: "新财务部", fdLoginName: "zhangsan" })
      ],
      采购岗: [
        currentOrg({ fdId: "new-post-wrong-parent", fdName: "采购岗", fdOrgType: 4, fdParentName: "华南采购部" }),
        currentOrg({ fdId: "new-post-1", fdName: "采购岗", fdOrgType: 4, fdParentName: "采购部" }),
        currentOrg({ fdId: "new-post-wrong-type", fdName: "采购岗", fdOrgType: 8, fdParentName: "采购部" })
      ],
      王五: [
        currentOrg({ fdId: "new-person-alternative", fdName: "王五", fdOrgType: 8, fdParentName: "采购部", fdLoginName: "wangwu" })
      ]
    });

    const result = await resolveWorkflowParticipants(dsl, { client });
    const members = result.dsl.workflow.nodes[1].participants.members;

    assert.deepEqual(members.map(({ id, name, targetOrgType }) => ({ id, name, targetOrgType })), [
      { id: "new-person-1", name: "张三（现用名）", targetOrgType: 8 },
      { id: "new-post-1", name: "采购岗", targetOrgType: 4 },
      { id: "new-person-1", name: "张三（现用名）", targetOrgType: 8 }
    ]);
    assert.deepEqual(members.map((member) => member.sourceId), [
      "legacy-person-1",
      "legacy-post-1",
      "legacy-person-1"
    ]);
    assert.deepEqual(
      result.dsl.workflow.nodes[1].participants.alternativeMembers.map(({ id, name, targetOrgType }) => ({ id, name, targetOrgType })),
      [{ id: "new-person-alternative", name: "王五", targetOrgType: 8 }]
    );
    assert.equal(result.dsl.workflow.nodes[1].participants.useAlternativeOnly, true);
    assert.equal(result.resolvedCount, 4);
    assert.equal(result.identityCount, 3);
    assert.deepEqual(client.calls, ["张三", "采购岗", "王五"]);
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
      })
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
        assert.deepEqual(error.issues.map((issue) => issue.reason), ["not_found", "ambiguous"]);
        assert.equal(error.message.includes("2 explicit workflow participant identities"), true);
        return true;
      }
    );
    assert.equal(dsl.workflow.nodes[1].participants.members[0].id, "0123456789abcdef0123456789abcdef");
  });
});

describe("executeDsl participant resolution seam", () => {
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
  });
});

describe("NewoaClient.searchOrg", () => {
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
});

class SearchClient {
  constructor(results = {}) {
    this.results = results;
    this.calls = [];
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
