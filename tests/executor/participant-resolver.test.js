import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeDsl } from "../../src/executor/execute.js";
import { NewoaClient, NEWOA_SIT_BASE_URL } from "../../src/executor/newoa-client.js";
import {
  ParticipantResolutionError,
  resolveWorkflowParticipants,
  SIT_PARTICIPANT_FALLBACKS
} from "../../src/executor/participant-resolver.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { localCorpusIt } from "../helpers/local-corpus.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

const SIT_FALLBACK_PERSON = SIT_PARTICIPANT_FALLBACKS.person;
const SIT_FALLBACK_POST = SIT_PARTICIPANT_FALLBACKS.post;
const SIT_FALLBACK_GROUP = SIT_PARTICIPANT_FALLBACKS.group;
const SIT_FALLBACK_DEPARTMENT = SIT_PARTICIPANT_FALLBACKS.department;

describe("resolveWorkflowParticipants", () => {
  it("materializes configured formula person fallbacks only at the allowed execution origin", async () => {
    const dsl = dslWithExplicitMembers([]);
    dsl.workflow.nodes[1].participants = {
      mode: "configured_person_fallback",
      fallbackKind: "person",
      reason: "related leader formula has no verified target recipe",
      sourceExpression: '$组织架构.解释角色线$($fd_department$, "公司级相关领导", "相关领导")',
      sourceNameExpression: '$组织架构.解释角色线$($部门$, "公司级相关领导", "相关领导")'
    };
    const configuredPersonId = "configured-formula-person-id";
    const client = new SearchClient({}, {
      [configuredPersonId]: [currentOrg({
        fdId: configuredPersonId,
        fdName: "配置公式兜底人",
        fdOrgType: 8
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      targetBaseUrl: NEWOA_SIT_BASE_URL,
      fallbackFdIds: { person: configuredPersonId }
    });

    assert.deepEqual(result.dsl.workflow.nodes[1].participants, {
      mode: "explicit",
      members: [{
        id: configuredPersonId,
        name: "配置公式兜底人",
        type: "user_or_org",
        targetOrgType: 8
      }]
    });
    assert.equal(result.identityCount, 1);
    assert.equal(result.fallbackCount, 1);
    assert.equal(result.fallbackIdentityCount, 1);
    assert.deepEqual(result.fallbackTargetIds, [configuredPersonId]);
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [[configuredPersonId]]);
  });

  it("rejects configured formula person fallbacks outside the allowed execution origins", async () => {
    const dsl = dslWithExplicitMembers([]);
    dsl.workflow.nodes[1].participants = {
      mode: "configured_person_fallback",
      fallbackKind: "person",
      reason: "related leader formula has no verified target recipe",
      sourceExpression: '$组织架构.解释角色线$($fd_department$, "公司级相关领导", "相关领导")'
    };
    const client = new SearchClient();

    await assert.rejects(
      resolveWorkflowParticipants(dsl, {
        client,
        targetBaseUrl: "https://production.example.com",
        fallbackFdIds: { person: "configured-formula-person-id" }
      }),
      (error) => error instanceof ParticipantResolutionError &&
        error.issues.every((issue) => issue.reason === "configured_fallback_origin_forbidden")
    );
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, []);
  });

  it("uses type-specific validated SIT fallbacks for source identities that cannot be found", async () => {
    const dsl = dslWithExplicitMembers([
      sourceMember({
        name: "不存在岗位",
        sourceId: "legacy-post-missing",
        sourceOrgType: 4,
        sourceParentName: "采购部"
      }),
      sourceMember({
        name: "不存在群组",
        sourceId: "legacy-group-missing",
        sourceOrgType: 16,
        sourceParentName: "总部"
      }),
      sourceMember({
        name: "不存在部门",
        sourceId: "legacy-dept-missing",
        sourceOrgType: 2,
        sourceParentName: "总部"
      })
    ]);
    const client = new SearchClient({
      不存在岗位: [],
      不存在群组: [],
      不存在部门: []
    }, sitFallbackElementResults());

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
        { id: SIT_FALLBACK_POST.fdId, name: SIT_FALLBACK_POST.fdName, targetOrgType: 4 },
        { id: SIT_FALLBACK_GROUP.fdId, name: SIT_FALLBACK_GROUP.fdName, targetOrgType: 16 },
        { id: SIT_FALLBACK_DEPARTMENT.fdId, name: SIT_FALLBACK_DEPARTMENT.fdName, targetOrgType: 2 }
      ]
    );
    assert.equal(result.fallbackCount, 3);
    assert.equal(result.fallbackIdentityCount, 3);
    assert.deepEqual(client.searchRequests, [
      { key: "不存在岗位", sourceOrgType: 4 },
      { key: "不存在群组", sourceOrgType: 16 },
      { key: "不存在部门", sourceOrgType: 2 }
    ]);
    assert.deepEqual(result.fallbackTargetIds, [
      SIT_FALLBACK_POST.fdId,
      SIT_FALLBACK_GROUP.fdId,
      SIT_FALLBACK_DEPARTMENT.fdId
    ].sort());
    assert.deepEqual(client.calls, ["不存在岗位", "不存在群组", "不存在部门"]);
    assert.deepEqual(client.elementCalls, [
      [
        SIT_FALLBACK_POST.fdId,
        SIT_FALLBACK_GROUP.fdId,
        SIT_FALLBACK_DEPARTMENT.fdId
      ].sort()
    ]);
  });

  it("uses configured fallback fdIds for people, organizations, groups, and posts", async () => {
    const fallbackFdIds = {
      person: "configured-person-id",
      organization: "configured-organization-id",
      group: "configured-group-id",
      post: "configured-post-id"
    };
    const dsl = dslWithExplicitMembers([
      sourceMember({ name: "缺失人员", sourceOrgType: 8, sourceParentName: "源部门" }),
      sourceMember({ name: "缺失组织", sourceOrgType: 2, sourceParentName: "源总部" }),
      sourceMember({ name: "缺失群组", sourceOrgType: 16, sourceParentName: "源总部" }),
      sourceMember({ name: "缺失岗位", sourceOrgType: 4, sourceParentName: "源部门" })
    ]);
    const client = new SearchClient({
      缺失人员: [],
      缺失组织: [],
      缺失群组: [],
      缺失岗位: []
    }, {
      [fallbackFdIds.person]: [currentOrg({ fdId: fallbackFdIds.person, fdName: "配置兜底人", fdOrgType: 8 })],
      [fallbackFdIds.organization]: [currentOrg({ fdId: fallbackFdIds.organization, fdName: "配置兜底组织", fdOrgType: 2 })],
      [fallbackFdIds.group]: [currentOrg({ fdId: fallbackFdIds.group, fdName: "配置兜底群组", fdOrgType: 16 })],
      [fallbackFdIds.post]: [currentOrg({ fdId: fallbackFdIds.post, fdName: "配置兜底岗位", fdOrgType: 4 })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      targetBaseUrl: NEWOA_SIT_BASE_URL,
      fallbackFdIds
    });

    assert.deepEqual(
      result.dsl.workflow.nodes[1].participants.members.map(({ id, name, targetOrgType }) => ({
        id,
        name,
        targetOrgType
      })),
      [
        { id: fallbackFdIds.person, name: "配置兜底人", targetOrgType: 8 },
        { id: fallbackFdIds.organization, name: "配置兜底组织", targetOrgType: 2 },
        { id: fallbackFdIds.group, name: "配置兜底群组", targetOrgType: 16 },
        { id: fallbackFdIds.post, name: "配置兜底岗位", targetOrgType: 4 }
      ]
    );
    assert.deepEqual(result.fallbackTargetIds, Object.values(fallbackFdIds).sort());
    assert.deepEqual(client.elementCalls, [Object.values(fallbackFdIds).sort()]);
  });

  it("uses an explicitly authorized configured fallback for unresolved template permissions", async () => {
    const fallbackPostId = "configured-template-permission-post-id";
    const dsl = dslWithExplicitMembers([]);
    dsl.template.authorization = {
      readerFlag: false,
      readers: [],
      editors: [],
      allReaders: [],
      allEditors: [],
      temporaryReaders: [sourceMember({
        name: "源系统已下线岗位",
        sourceId: "legacy-template-permission-post",
        sourceOrgType: 4,
        sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgPost",
        sourceParentName: "源系统部门"
      })],
      temporaryEditors: []
    };
    const client = new SearchClient({
      源系统已下线岗位: []
    }, {
      [fallbackPostId]: [currentOrg({
        fdId: fallbackPostId,
        fdName: "配置模版权限兜底岗位",
        fdOrgType: 4
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      targetBaseUrl: NEWOA_SIT_BASE_URL,
      fallbackFdIds: { post: fallbackPostId },
      allowTemplateAuthorizationFallback: true
    });

    assert.deepEqual(
      result.dsl.template.authorization.temporaryReaders,
      [{
        id: fallbackPostId,
        name: "配置模版权限兜底岗位",
        type: "user_or_org",
        sourceId: "legacy-template-permission-post",
        sourceOrgType: 4,
        sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgPost",
        sourceParentName: "源系统部门",
        targetOrgType: 4
      }]
    );
    assert.equal(result.fallbackCount, 1);
    assert.equal(result.fallbackIdentityCount, 1);
    assert.deepEqual(result.fallbackTargetIds, [fallbackPostId]);
    assert.deepEqual(client.elementCalls, [[fallbackPostId]]);
  });

  it("rejects one configured fallback fdId reused across incompatible participant types", async () => {
    const sharedFdId = "configured-shared-person-group-id";
    const dsl = dslWithExplicitMembers([
      sourceMember({ name: "缺失群组", sourceOrgType: 16, sourceParentName: "源总部" }),
      sourceMember({ name: "缺失人员", sourceOrgType: 8, sourceParentName: "源部门" })
    ]);
    const client = new SearchClient({ 缺失人员: [], 缺失群组: [] }, {
      [sharedFdId]: [currentOrg({ fdId: sharedFdId, fdName: "仅为人员类型", fdOrgType: 8 })]
    });

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        targetBaseUrl: NEWOA_SIT_BASE_URL,
        fallbackFdIds: { person: sharedFdId, group: sharedFdId }
      }),
      (error) => {
        assert.equal(
          error.issues.some((issue) =>
            issue.reason === "fallback_target_type_mismatch" && issue.expectedOrgType === 16
          ),
          true
        );
        return true;
      }
    );
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
    }, sitFallbackElementResults());

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

  it("keeps unresolved identities blocking outside the allowed temporary-fallback origins", async () => {
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "不存在岗位",
      sourceId: "legacy-post-missing",
      sourceOrgType: 4,
      sourceParentName: "采购部"
    })]);
    const configuredPostId = "must-not-be-used-outside-allowed-origin";
    const client = new SearchClient({ 不存在岗位: [] }, {
      [configuredPostId]: [currentOrg({ fdId: configuredPostId, fdName: "不可使用兜底岗位", fdOrgType: 4 })]
    });

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        targetBaseUrl: "https://p-sit.onewo.com:8443",
        fallbackFdIds: { post: configuredPostId }
      }),
      (error) => {
        assert.deepEqual(error.issues.map((issue) => issue.reason), ["not_found"]);
        return true;
      }
    );
    assert.deepEqual(client.elementCalls, []);
  });

  it("applies the same type-specific fallbacks on the Shanghai Electric POC origin", async () => {
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "不存在岗位",
      sourceId: "legacy-post-missing",
      sourceOrgType: 4,
      sourceParentName: "采购部"
    })]);
    const client = new SearchClient({ 不存在岗位: [] }, sitFallbackElementResults());

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      targetBaseUrl: "http://mkpaaspoc.shanghai-electric.com/"
    });

    assert.deepEqual(
      result.dsl.workflow.nodes[1].participants.members.map(({ id, name, targetOrgType }) => ({
        id,
        name,
        targetOrgType
      })),
      [{ id: SIT_FALLBACK_POST.fdId, name: SIT_FALLBACK_POST.fdName, targetOrgType: 4 }]
    );
    assert.equal(result.fallbackCount, 1);
    assert.deepEqual(result.fallbackTargetIds, [SIT_FALLBACK_POST.fdId]);
  });

  it("requires each configured SIT fallback fdId to resolve to the expected org type", async () => {
    const configuredPostId = "configured-wrong-type-post-id";
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "不存在岗位",
      sourceId: "legacy-post-missing",
      sourceOrgType: 4,
      sourceParentName: "采购部"
    })]);
    const client = new SearchClient({ 不存在岗位: [] }, {
      [configuredPostId]: [currentOrg({
        fdId: configuredPostId,
        fdName: "错误的人员目标",
        fdOrgType: 8
      })]
    });

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        targetBaseUrl: NEWOA_SIT_BASE_URL,
        fallbackFdIds: { post: configuredPostId }
      }),
      (error) => {
        assert.deepEqual(error.issues.map((issue) => issue.reason), ["fallback_target_type_mismatch"]);
        assert.equal(error.issues[0].expectedOrgType, 4);
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
    const client = new SearchClient({}, sitFallbackElementResults());

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

  it("uses the configured fallback when organization search fails on an allowed temporary-fallback origin", async () => {
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "查询失败的审批人",
      sourceId: "legacy-search-failure",
      sourceOrgType: 8,
      sourceParentName: "采购部"
    })]);
    const client = new SearchClient({}, sitFallbackElementResults());
    client.searchOrg = async () => {
      throw new Error("organization API unavailable");
    };

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
      [{ id: SIT_FALLBACK_PERSON.fdId, name: SIT_FALLBACK_PERSON.fdName, targetOrgType: 8 }]
    );
    assert.equal(result.fallbackCount, 1);
    assert.deepEqual(client.elementCalls, [[SIT_FALLBACK_PERSON.fdId]]);
  });

  it("keeps organization API failures blocking outside temporary-fallback origins", async () => {
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "查询失败的审批人",
      sourceId: "legacy-search-failure",
      sourceOrgType: 8,
      sourceParentName: "采购部"
    })]);
    const client = new SearchClient({}, sitFallbackElementResults());
    client.searchOrg = async () => {
      throw new Error("organization API unavailable");
    };

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        targetBaseUrl: "https://p-sit.onewo.com:8443"
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

  it("applies distinct direct-target overrides after exact current type validation", async () => {
    const dsl = dslWithExplicitMembers([
      {
        id: "legacy-direct-person-a",
        name: "张康永",
        type: "user_or_org",
        targetOrgType: 8
      },
      {
        id: "legacy-direct-person-b",
        name: "郑汉敏",
        type: "user_or_org",
        targetOrgType: 8
      }
    ]);
    const client = new SearchClient({}, {
      "current-person-a": [currentOrg({
        fdId: "current-person-a",
        fdName: "张康永",
        fdOrgType: 8
      })],
      "current-person-b": [currentOrg({
        fdId: "current-person-b",
        fdName: "admin-ce",
        fdOrgType: 8
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      directParticipantOverrides: [
        { sourceTargetId: "legacy-direct-person-a", targetFdId: "current-person-a" },
        { sourceTargetId: "legacy-direct-person-b", targetFdId: "current-person-b" }
      ]
    });

    assert.deepEqual(
      result.dsl.workflow.nodes[1].participants.members.map((member) => member.id),
      ["current-person-a", "current-person-b"]
    );
    assert.equal(result.directOverrideCount, 2);
    assert.equal(result.directOverrideIdentityCount, 2);
    assert.deepEqual(result.directOverrideTargetIds, ["current-person-a", "current-person-b"]);
    assert.deepEqual(
      result.directOverrides.map((override) => override.sourceTargetEvidence.fdId),
      ["legacy-direct-person-a", "legacy-direct-person-b"]
    );
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [["current-person-a"], ["current-person-b"]]);
  });

  it("rejects a direct-target override whose current target type changed", async () => {
    const dsl = dslWithExplicitMembers([{
      id: "legacy-direct-person",
      name: "审批人",
      type: "user_or_org",
      targetOrgType: 8
    }]);
    const client = new SearchClient({}, {
      "current-department": [currentOrg({
        fdId: "current-department",
        fdName: "审批部门",
        fdOrgType: 2
      })]
    });

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        directParticipantOverrides: [{
          sourceTargetId: "legacy-direct-person",
          targetFdId: "current-department"
        }]
      }),
      (error) => error instanceof ParticipantResolutionError &&
        error.issues.some((issue) => issue.reason === "direct_override_target_type_mismatch")
    );
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [["current-department"]]);
  });

  it("applies an explicit sourceId override only after exact current-target validation", async () => {
    const sourceId = "legacy-ambiguous-person";
    const targetFdId = "current-mkpaas-person";
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "叶明明",
      sourceId,
      sourceOrgType: 8,
      sourceParentName: "审批部"
    })]);
    const client = new SearchClient({
      叶明明: [
        currentOrg({ fdId: "same-name-a", fdName: "叶明明", fdOrgType: 8, fdParentName: "审批部" }),
        currentOrg({ fdId: "same-name-b", fdName: "叶明明", fdOrgType: 8, fdParentName: "审批部" })
      ]
    }, {
      [targetFdId]: [currentOrg({
        fdId: targetFdId,
        fdName: "mkpaas",
        fdOrgType: 8
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      participantOverrides: [{ sourceId, targetFdId }]
    });
    const member = result.dsl.workflow.nodes[1].participants.members[0];

    assert.equal(member.id, targetFdId);
    assert.equal(member.name, "mkpaas");
    assert.equal(member.targetOrgType, 8);
    assert.equal(member.sourceId, sourceId);
    assert.equal(member.sourceOrgType, 8);
    assert.equal(member.sourceParentName, "审批部");
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [[targetFdId]]);
    assert.equal(result.overrideCount, 1);
    assert.equal(result.overrideIdentityCount, 1);
    assert.deepEqual(result.overrideTargetIds, [targetFdId]);
    assert.deepEqual(result.overrides, [{
      sourceEvidence: {
        sourceId,
        name: "叶明明",
        sourceOrgType: 8,
        sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgPerson",
        sourceParentName: "审批部"
      },
      target: {
        fdId: targetFdId,
        fdName: "mkpaas",
        fdOrgType: 8
      },
      referenceCount: 1,
      paths: ["/workflow/nodes/1/participants/members/0"]
    }]);
  });

  it("keeps workflow overrides isolated from template authorization with the same source id", async () => {
    const sourceId = "shared-workflow-authorization-person";
    const targetFdId = "workflow-only-override-person";
    const member = sourceMember({
      name: "叶明明",
      sourceId,
      sourceOrgType: 8,
      sourceParentName: "审批部"
    });
    const dsl = dslWithExplicitMembers([member]);
    dsl.template.authorization = {
      readerFlag: false,
      readers: [structuredClone(member)],
      editors: [],
      allReaders: [],
      allEditors: [],
      temporaryReaders: [],
      temporaryEditors: []
    };
    const client = new SearchClient({
      叶明明: [currentOrg({
        fdId: sourceId,
        fdName: "叶明明",
        fdOrgType: 8,
        fdParentName: "审批部"
      })]
    }, {
      [targetFdId]: [currentOrg({
        fdId: targetFdId,
        fdName: "workflow-target",
        fdOrgType: 8
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      participantOverrides: [{ sourceId, targetFdId }]
    });

    assert.equal(result.dsl.workflow.nodes[1].participants.members[0].id, targetFdId);
    assert.equal(result.dsl.template.authorization.readers[0].id, sourceId);
    assert.equal(result.overrideCount, 1);
    assert.equal(result.overrideIdentityCount, 1);
    assert.deepEqual(result.overrides[0].paths, [
      "/workflow/nodes/1/participants/members/0"
    ]);
    assert.deepEqual(client.calls, ["叶明明"]);
    assert.deepEqual(client.elementCalls, [[targetFdId]]);
  });

  it("applies a parentless template authorization override only after exact name and type validation", async () => {
    const sourceId = "legacy-parentless-authorization-post";
    const targetFdId = "current-parentless-authorization-post";
    const authorizationMember = sourceMember({
      name: "财务部_部长",
      sourceId,
      sourceOrgType: 4,
      sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgElement",
      sourceParentName: undefined
    });
    const dsl = dslWithExplicitMembers([]);
    dsl.template.authorization = {
      readerFlag: false,
      readers: [],
      editors: [],
      allReaders: [],
      allEditors: [],
      temporaryReaders: [authorizationMember],
      temporaryEditors: []
    };
    const client = new SearchClient({}, {
      [targetFdId]: [currentOrg({
        fdId: targetFdId,
        fdName: authorizationMember.name,
        fdOrgType: authorizationMember.sourceOrgType,
        fdParentName: ""
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      templateAuthorizationOverrides: [{ sourceId, targetFdId }]
    });

    assert.deepEqual(result.dsl.template.authorization.temporaryReaders[0], {
      ...authorizationMember,
      id: targetFdId,
      name: authorizationMember.name,
      targetOrgType: 4
    });
    assert.equal(result.templateAuthorizationOverrideCount, 1);
    assert.equal(result.templateAuthorizationOverrideIdentityCount, 1);
    assert.deepEqual(result.templateAuthorizationOverrideTargetIds, [targetFdId]);
    assert.deepEqual(result.templateAuthorizationOverrides[0].paths, [
      "/template/authorization/temporaryReaders/0"
    ]);
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [[targetFdId]]);

    for (const [candidate, reason] of [
      [{ fdName: "其他岗位", fdOrgType: 4 }, "template_authorization_override_target_name_mismatch"],
      [{ fdName: authorizationMember.name, fdOrgType: 8 }, "template_authorization_override_target_type_mismatch"]
    ]) {
      const mismatchClient = new SearchClient({}, {
        [targetFdId]: [currentOrg({
          fdId: targetFdId,
          fdParentName: "",
          ...candidate
        })]
      });
      await assert.rejects(
        () => resolveWorkflowParticipants(dsl, {
          client: mismatchClient,
          templateAuthorizationOverrides: [{ sourceId, targetFdId }]
        }),
        (error) => error instanceof ParticipantResolutionError &&
          error.issues.some((issue) => issue.reason === reason)
      );
    }
  });

  it("revalidates a parentless source post only when the same current id and name match", async () => {
    const sourceId = "current-parentless-post";
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "财务部_部长",
      sourceId,
      sourceOrgType: 4,
      sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgElement",
      sourceParentName: undefined
    })]);
    const client = new SearchClient({}, {
      [sourceId]: [currentOrg({
        fdId: sourceId,
        fdName: "财务部_部长",
        fdOrgType: 4,
        fdParentName: ""
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      participantOverrides: [{ sourceId, targetFdId: sourceId }]
    });

    assert.equal(result.dsl.workflow.nodes[1].participants.members[0].id, sourceId);
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [[sourceId]]);
    assert.equal(result.overrides[0].exactSourceIdRevalidation, true);
  });

  it("rejects parentless same-id revalidation when the current target name changed", async () => {
    const sourceId = "reassigned-parentless-post";
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "原岗位",
      sourceId,
      sourceOrgType: 4,
      sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgElement",
      sourceParentName: undefined
    })]);
    const client = new SearchClient({}, {
      [sourceId]: [currentOrg({
        fdId: sourceId,
        fdName: "其他岗位",
        fdOrgType: 4,
        fdParentName: ""
      })]
    });

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        participantOverrides: [{ sourceId, targetFdId: sourceId }]
      }),
      (error) => error instanceof ParticipantResolutionError &&
        error.issues.some((issue) => issue.reason === "override_target_name_mismatch")
    );
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [[sourceId]]);
  });

  it("rejects an explicit participant override whose current target has an incompatible org type", async () => {
    const sourceId = "legacy-person-for-wrong-target";
    const targetFdId = "current-department-target";
    const dsl = dslWithExplicitMembers([sourceMember({ sourceId, sourceOrgType: 8 })]);
    const client = new SearchClient({}, {
      [targetFdId]: [currentOrg({
        fdId: targetFdId,
        fdName: "错误部门目标",
        fdOrgType: 2
      })]
    });

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        participantOverrides: [{ sourceId, targetFdId }]
      }),
      (error) => {
        assert.equal(error instanceof ParticipantResolutionError, true);
        assert.deepEqual(error.issues.map((issue) => issue.reason), ["override_target_type_mismatch"]);
        assert.equal(error.issues[0].expectedOrgType, 8);
        assert.equal(error.issues[0].targetOrgType, 2);
        return true;
      }
    );
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [[targetFdId]]);
  });

  it("accepts explicitly confirmed configured fallbacks for incomplete people and legacy roles", async () => {
    const personSourceId = "legacy-parentless-person";
    const roleSourceId = "legacy-missing-role";
    const personTargetId = "configured-person-fallback";
    const groupTargetId = "configured-group-fallback";
    const dsl = dslWithExplicitMembers([
      sourceMember({
        name: "熊涛",
        sourceId: personSourceId,
        sourceOrgType: 8,
        sourceParentName: undefined
      }),
      sourceMember({
        name: "综合事务管理员",
        sourceId: roleSourceId,
        sourceOrgType: 32,
        sourceParentName: undefined
      })
    ]);
    const client = new SearchClient({}, {
      [personTargetId]: [currentOrg({
        fdId: personTargetId,
        fdName: "配置兜底人",
        fdOrgType: 8
      })],
      [groupTargetId]: [currentOrg({
        fdId: groupTargetId,
        fdName: "配置兜底群组",
        fdOrgType: 16
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      targetBaseUrl: NEWOA_SIT_BASE_URL,
      fallbackFdIds: { person: personTargetId, group: groupTargetId },
      participantOverrides: [
        { sourceId: personSourceId, targetFdId: personTargetId },
        { sourceId: roleSourceId, targetFdId: groupTargetId }
      ]
    });

    assert.deepEqual(
      result.dsl.workflow.nodes[1].participants.members.map((member) => ({
        id: member.id,
        targetOrgType: member.targetOrgType
      })),
      [
        { id: personTargetId, targetOrgType: 8 },
        { id: groupTargetId, targetOrgType: 16 }
      ]
    );
    assert.equal(result.overrideIdentityCount, 2);
    assert.ok(result.overrides.every((override) => override.confirmedFallbackOverride === true));
    assert.deepEqual(client.calls, []);
  });

  it("rejects unknown and ambiguous sourceIds in explicit participant override configuration", async () => {
    const dsl = dslWithExplicitMembers([
      sourceMember({ name: "审批人甲", sourceId: "shared-source-id", sourceParentName: "甲部门" }),
      sourceMember({ name: "审批人乙", sourceId: "shared-source-id", sourceParentName: "乙部门" })
    ]);
    const client = new SearchClient();

    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        participantOverrides: [{
          sourceId: "shared-source-id",
          targetFdId: "target-person-id"
        }]
      }),
      (error) => error instanceof ParticipantResolutionError &&
        error.issues.some((issue) => issue.reason === "override_source_ambiguous")
    );
    await assert.rejects(
      () => resolveWorkflowParticipants(dsl, {
        client,
        participantOverrides: [{
          sourceId: "missing-source-id",
          targetFdId: "target-person-id"
        }]
      }),
      (error) => error instanceof ParticipantResolutionError &&
        error.issues.some((issue) => issue.reason === "override_source_not_found")
    );
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, []);
  });

  it("keeps explicit-override and temporary-fallback accounting separate when they share a target", async () => {
    const targetFdId = "shared-current-person";
    const explicitSourceId = "legacy-explicit-person";
    const dsl = dslWithExplicitMembers([
      sourceMember({
        name: "明确覆盖人员",
        sourceId: explicitSourceId,
        sourceParentName: "审批部"
      }),
      sourceMember({
        name: "当前环境缺失人员",
        sourceId: "legacy-missing-person",
        sourceParentName: "审批部"
      })
    ]);
    const client = new SearchClient({
      当前环境缺失人员: []
    }, {
      [targetFdId]: [currentOrg({
        fdId: targetFdId,
        fdName: "mkpaas",
        fdOrgType: 8
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      targetBaseUrl: NEWOA_SIT_BASE_URL,
      fallbackFdIds: { person: targetFdId },
      participantOverrides: [{ sourceId: explicitSourceId, targetFdId }]
    });

    assert.equal(result.overrideCount, 1);
    assert.equal(result.overrideIdentityCount, 1);
    assert.equal(result.fallbackCount, 1);
    assert.equal(result.fallbackIdentityCount, 1);
    assert.deepEqual(result.overrideTargetIds, [targetFdId]);
    assert.deepEqual(result.fallbackTargetIds, [targetFdId]);
    assert.deepEqual(client.calls, ["当前环境缺失人员"]);
    assert.deepEqual(client.elementCalls, [[targetFdId]]);
    assert.deepEqual(
      result.dsl.workflow.nodes[1].participants.members.map((member) => member.id),
      [targetFdId]
    );
  });

  it("resolves a parentless role-line participant by its stable role id before name search", async () => {
    const roleId = "149cb36bda232828b2168944bde8c95b";
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "部门领导",
      sourceId: roleId,
      sourceOrgType: 32,
      sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgElement",
      sourceParentName: undefined
    })]);
    const client = new SearchClient({}, {
      [roleId]: [currentOrg({
        fdId: roleId,
        fdName: "部门领导",
        fdOrgType: 32,
        fdParentName: ""
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, { client });
    const member = result.dsl.workflow.nodes[1].participants.members[0];

    assert.equal(member.id, roleId);
    assert.equal(member.name, "部门领导");
    assert.equal(member.targetOrgType, 32);
    assert.equal(result.fallbackCount, 0);
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [[roleId]]);
  });

  it("does not let a stable role id bypass required source-name evidence", async () => {
    const roleId = "149cb36bda232828b2168944bde8c95b";
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "",
      sourceId: roleId,
      sourceOrgType: 32,
      sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgElement",
      sourceParentName: undefined
    })]);
    const client = new SearchClient({}, {
      [roleId]: [currentOrg({
        fdId: roleId,
        fdName: "部门领导",
        fdOrgType: 32,
        fdParentName: ""
      })]
    });

    await assert.rejects(
      resolveWorkflowParticipants(dsl, { client }),
      (error) => error instanceof ParticipantResolutionError &&
        error.issues.some((issue) =>
          issue.reason === "missing_source_evidence" &&
          issue.missing.includes("name")
        )
    );
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, []);
  });

  it("requires exact element validation capability for stable source role ids", async () => {
    const roleId = "149cb36bda232828b2168944bde8c95b";
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "部门领导",
      sourceId: roleId,
      sourceOrgType: 32,
      sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgElement",
      sourceParentName: undefined
    })]);
    const calls = [];
    const client = {
      async searchOrg(name, sourceOrgType) {
        calls.push({ name, sourceOrgType });
        return [];
      }
    };

    await assert.rejects(
      resolveWorkflowParticipants(dsl, { client }),
      (error) => error instanceof ParticipantResolutionError &&
        error.issues.some((issue) =>
          issue.reason === "source_role_validation_unavailable"
        )
    );
    assert.deepEqual(calls, []);
  });

  it("does not hide a stable role-id type mismatch behind the SIT person fallback", async () => {
    const roleId = "149cb36bda232828b2168944bde8c95b";
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "部门领导",
      sourceId: roleId,
      sourceOrgType: 32,
      sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgElement",
      sourceParentName: undefined
    })]);
    const client = new SearchClient({}, {
      ...sitFallbackElementResults(),
      [roleId]: [currentOrg({
        fdId: roleId,
        fdName: "错误人员",
        fdOrgType: 8,
        fdParentName: ""
      })]
    });

    await assert.rejects(
      resolveWorkflowParticipants(dsl, {
        client,
        targetBaseUrl: NEWOA_SIT_BASE_URL
      }),
      (error) => error instanceof ParticipantResolutionError &&
        error.issues.some((issue) =>
          issue.reason === "source_role_id_type_mismatch" &&
          issue.sourceId === roleId &&
          issue.targetOrgType === 8
        )
    );
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [[roleId]]);
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

  it("resolves a bracketed generic role by its unique exact name without requiring a parent", async () => {
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "<直线领导>",
      sourceId: "legacy-direct-manager-role",
      sourceOrgType: 32,
      sourceParentName: undefined
    })]);
    const client = new SearchClient({
      "<直线领导>": [currentOrg({
        fdId: "current-direct-manager-role",
        fdName: "<直线领导>",
        fdOrgType: 32
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      targetBaseUrl: "https://production.example.com"
    });

    assert.equal(result.resolvedCount, 1);
    assert.equal(
      result.dsl.workflow.nodes[1].participants.members[0].id,
      "current-direct-manager-role"
    );
    assert.equal(result.dsl.workflow.nodes[1].participants.members[0].targetOrgType, 32);
    assert.deepEqual(client.searchRequests, [{
      key: "<直线领导>",
      sourceOrgType: 32
    }]);
  });

  it("keeps duplicate bracketed generic-role names blocking", async () => {
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "<直线领导>",
      sourceId: "legacy-direct-manager-role",
      sourceOrgType: 32,
      sourceParentName: undefined
    })]);
    const client = new SearchClient({
      "<直线领导>": [
        currentOrg({
          fdId: "current-direct-manager-role-a",
          fdName: "<直线领导>",
          fdOrgType: 32
        }),
        currentOrg({
          fdId: "current-direct-manager-role-b",
          fdName: "<直线领导>",
          fdOrgType: 32
        })
      ]
    });

    await assert.rejects(
      resolveWorkflowParticipants(dsl, {
        client,
        targetBaseUrl: "https://production.example.com"
      }),
      (error) => error instanceof ParticipantResolutionError &&
        error.issues.some((issue) =>
          issue.reason === "ambiguous" &&
          issue.name === "<直线领导>"
        )
    );
  });

  it("does not replace a missing bracketed generic role with the temporary person fallback", async () => {
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "<直线领导>",
      sourceId: "legacy-direct-manager-role",
      sourceOrgType: 32,
      sourceParentName: undefined
    })]);
    const client = new SearchClient({
      "<直线领导>": []
    }, sitFallbackElementResults());

    await assert.rejects(
      resolveWorkflowParticipants(dsl, {
        client,
        targetBaseUrl: NEWOA_SIT_BASE_URL
      }),
      (error) => error instanceof ParticipantResolutionError &&
        error.issues.some((issue) =>
          issue.reason === "not_found" &&
          issue.name === "<直线领导>"
        )
    );
    assert.deepEqual(client.elementCalls, [["legacy-direct-manager-role"]]);
  });

  it("resolves legacy qualified post names by leaf name and parent-path suffix", async () => {
    const dsl = dslWithExplicitMembers([
      sourceMember({
        name: "环保集团本部（机电院）工业设计工程研究院_总经理",
        sourceId: "legacy-qualified-post",
        sourceOrgType: 4,
        sourceParentName: "环保集团本部（机电院）工业设计工程研究院"
      })
    ]);
    const client = new SearchClient({
      总经理: [currentOrg({
        fdId: "current-general-manager-post",
        fdName: "总经理",
        fdOrgType: 4,
        fdParentName: "上海电气集团/环保集团本部（机电院）工业设计工程研究院"
      })]
    });

    const result = await resolveWorkflowParticipants(dsl, {
      client,
      targetBaseUrl: "https://production.example.com"
    });

    assert.equal(result.resolvedCount, 1);
    assert.equal(result.dsl.workflow.nodes[1].participants.members[0].id, "current-general-manager-post");
    assert.deepEqual(client.searchRequests, [{ key: "总经理", sourceOrgType: 4 }]);
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
    const client = new SearchClient({}, sitFallbackElementResults());

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
    const allowedFallbackIds = new Set(Object.values(SIT_PARTICIPANT_FALLBACKS).map((item) => item.fdId));
    assert.equal(result.identityCount, 57);
    assert.equal(result.fallbackIdentityCount, 57);
    assert.equal(result.fallbackCount, 326);
    assert.equal(sourceReferenceCount, 326);
    assert.equal(references.every((member) => allowedFallbackIds.has(member.id)), true);
    assert.equal(references.some((member) => member.id === SIT_FALLBACK_PERSON.fdId), true);
    assert.equal(references.some((member) => member.id === SIT_FALLBACK_POST.fdId), true);
    assert.equal(collections.every((members) => (
      new Set(members.map((member) => member.id)).size === members.length
    )), true);
    assert.equal(n210.participants.members.length, 1);
    assert.equal(n378.participants.alternativeMembers.length, 1);
    assert.deepEqual(client.elementCalls, [
      ["149cb36bda232828b2168944bde8c95b"],
      [
        SIT_FALLBACK_PERSON.fdId,
        SIT_FALLBACK_POST.fdId
      ].sort()
    ]);
  });

  it("bounds concurrent organization searches so NewOA is not flooded", async () => {
    const members = Array.from({ length: 12 }, (_, index) => sourceMember({
      name: `人员${index}`,
      sourceId: `legacy-person-${index}`,
      sourceOrgType: 8,
      sourceParentName: `部门${index}`
    }));
    let active = 0;
    let maxActive = 0;
    const client = {
      async searchOrg(name, sourceOrgType) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        const index = Number(name.replace("人员", ""));
        return [currentOrg({
          fdId: `current-person-${index}`,
          fdName: name,
          fdOrgType: sourceOrgType,
          fdParentName: `部门${index}`
        })];
      }
    };

    const result = await resolveWorkflowParticipants(dslWithExplicitMembers(members), {
      client,
      targetBaseUrl: "https://production.example.com"
    });

    assert.equal(result.resolvedCount, 12);
    assert.equal(maxActive, 1, `observed ${maxActive} concurrent searches`);
  });
});

describe("executeDsl participant resolution seam", () => {
  it("audits and persists an exact template authorization override separately", async () => {
    const sourceId = "legacy-parentless-template-post";
    const targetFdId = "current-parentless-template-post";
    const dsl = dslWithExplicitMembers([]);
    dsl.template.authorization = {
      readerFlag: false,
      readers: [],
      editors: [],
      allReaders: [],
      allEditors: [],
      temporaryReaders: [sourceMember({
        name: "财务部_部长",
        sourceId,
        sourceOrgType: 4,
        sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgElement",
        sourceParentName: undefined
      })],
      temporaryEditors: []
    };
    const client = new CompleteSearchClient({}, {
      [targetFdId]: [currentOrg({
        fdId: targetFdId,
        fdName: "财务部_部长",
        fdOrgType: 4,
        fdParentName: ""
      })]
    });

    const result = await executeDsl(dsl, {
      client,
      credentials: { username: "route-user", encryptedPassword: "route-password" },
      confirmWrite: true,
      targetCategoryId: "category-1",
      templateAuthorizationOverrides: [{ sourceId, targetFdId }],
      now: new Date("2026-07-10T10:00:00.000Z")
    });
    const stage = result.apiStages.find((item) => item.name === "resolveWorkflowParticipants");
    const warning = result.diagnostics.find((item) => (
      item.code === "template.authorization_explicit_override_applied"
    ));

    assert.equal(result.ok, true);
    assert.equal(stage.templateAuthorizationOverrideCount, 1);
    assert.equal(stage.templateAuthorizationOverrideIdentityCount, 1);
    assert.deepEqual(stage.templateAuthorizationOverrideTargetIds, [targetFdId]);
    assert.equal(warning.details.referenceCount, 1);
    assert.deepEqual(client.savedTemplate.fdTmpReaders.map((member) => member.fdId), [
      targetFdId
    ]);
  });

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
    const client = new CompleteSearchClient({}, sitFallbackElementResults());

    const result = await executeDsl(dsl, {
      client,
      credentials: { username: SIT_FALLBACK_PERSON.fdName, encryptedPassword: "route-password" },
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
      id: SIT_FALLBACK_PERSON.fdId,
      name: SIT_FALLBACK_PERSON.fdName,
      element: "user",
      type: "1"
    }]);
    assert.equal(reviewNode.handlerIds, SIT_FALLBACK_PERSON.fdId);
    assert.equal(reviewNode.handlerNames, SIT_FALLBACK_PERSON.fdName);
    assert.equal(JSON.stringify(reviewNode.handlers).includes("legacy-person-not-in-sit"), false);
    assert.equal(stage.fallbackCount, 1);
    assert.equal(stage.fallbackIdentityCount, 1);
    assert.equal(stage.fallbackTargetId, SIT_FALLBACK_PERSON.fdId);
    assert.deepEqual(stage.fallbackTargetIds, [SIT_FALLBACK_PERSON.fdId]);
    assert.equal(stage.fallbackTargetsByOrgType["8"].targetName, "[REDACTED]");
    assert.equal(
      result.diagnostics.find((item) => item.code === "workflow.participant_sit_fallback_applied")
        .details.targetsByOrgType["8"].targetName,
      "[REDACTED]"
    );
    assert.equal(JSON.stringify(result).includes(SIT_FALLBACK_PERSON.fdName), false);
    assert.equal(
      result.diagnostics.some((item) => item.code === "workflow.participant_sit_fallback_applied"),
      true
    );
  });

  it("passes configured fallback fdIds through execution into workflow persistence", async () => {
    const personFdId = "configured-execute-person-id";
    const dsl = dslWithExplicitMembers([
      sourceMember({
        name: "目标环境不存在的审批人",
        sourceId: "legacy-person-missing",
        sourceOrgType: 8,
        sourceParentName: "源系统部门"
      })
    ]);
    const client = new CompleteSearchClient({}, {
      [personFdId]: [currentOrg({ fdId: personFdId, fdName: "配置执行兜底人", fdOrgType: 8 })]
    });

    const result = await executeDsl(dsl, {
      client,
      credentials: { username: "route-user", encryptedPassword: "route-password" },
      confirmWrite: true,
      targetCategoryId: "category-1",
      baseUrl: NEWOA_SIT_BASE_URL,
      fallbackFdIds: { person: personFdId },
      now: new Date("2026-07-10T10:00:00.000Z")
    });
    const workflow = JSON.parse(client.savedTemplate.mechanisms.lbpmTemplate[0].fdContent);
    const members = workflow.elements.find((element) => element.id === "N-review").handlers.members;

    assert.equal(result.ok, true);
    assert.deepEqual(members.map(({ id, name }) => ({ id, name })), [{
      id: personFdId,
      name: "配置执行兜底人"
    }]);
    assert.deepEqual(
      result.apiStages.find((stage) => stage.name === "resolveWorkflowParticipants").fallbackTargetIds,
      [personFdId]
    );
  });

  it("reports an audited warning when execution applies an explicit participant override", async () => {
    const sourceId = "legacy-explicit-person";
    const targetFdId = "current-explicit-person";
    const dsl = dslWithExplicitMembers([sourceMember({
      name: "叶明明",
      sourceId,
      sourceOrgType: 8,
      sourceParentName: "审批部"
    })]);
    const client = new CompleteSearchClient({}, {
      [targetFdId]: [currentOrg({
        fdId: targetFdId,
        fdName: "mkpaas",
        fdOrgType: 8
      })]
    });

    const result = await executeDsl(dsl, {
      client,
      credentials: { username: "route-user", encryptedPassword: "route-password" },
      confirmWrite: true,
      targetCategoryId: "category-1",
      participantOverrides: [{ sourceId, targetFdId }],
      now: new Date("2026-07-10T10:00:00.000Z")
    });
    const workflow = JSON.parse(client.savedTemplate.mechanisms.lbpmTemplate[0].fdContent);
    const members = workflow.elements.find((element) => element.id === "N-review").handlers.members;
    const stage = result.apiStages.find((item) => item.name === "resolveWorkflowParticipants");
    const warning = result.diagnostics.find((item) => (
      item.code === "workflow.participant_explicit_override_applied"
    ));

    assert.equal(result.ok, true);
    assert.equal(result.status, "written_with_warnings");
    assert.deepEqual(members.map(({ id, name }) => ({ id, name })), [{
      id: targetFdId,
      name: "mkpaas"
    }]);
    assert.equal(stage.overrideCount, 1);
    assert.equal(stage.overrideIdentityCount, 1);
    assert.deepEqual(stage.overrideTargetIds, [targetFdId]);
    assert.equal(stage.overrides[0].sourceEvidence.sourceId, sourceId);
    assert.equal(stage.overrides[0].sourceEvidence.name, "叶明明");
    assert.equal(stage.overrides[0].target.fdId, targetFdId);
    assert.equal(warning.details.referenceCount, 1);
    assert.equal(warning.details.overrides[0].sourceEvidence.sourceParentName, "审批部");
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [[targetFdId]]);
  });

  it("reports an audited warning when execution applies a direct participant override", async () => {
    const sourceTargetId = "legacy-direct-person";
    const targetFdId = "current-direct-person";
    const dsl = dslWithExplicitMembers([{
      id: sourceTargetId,
      name: "郑汉敏",
      type: "user_or_org",
      targetOrgType: 8
    }]);
    const client = new CompleteSearchClient({}, {
      [targetFdId]: [currentOrg({
        fdId: targetFdId,
        fdName: "admin-ce",
        fdOrgType: 8
      })]
    });

    const result = await executeDsl(dsl, {
      client,
      credentials: { username: "route-user", encryptedPassword: "route-password" },
      confirmWrite: true,
      targetCategoryId: "category-1",
      directParticipantOverrides: [{ sourceTargetId, targetFdId }],
      now: new Date("2026-07-10T10:00:00.000Z")
    });
    const workflow = JSON.parse(client.savedTemplate.mechanisms.lbpmTemplate[0].fdContent);
    const members = workflow.elements.find((element) => element.id === "N-review").handlers.members;
    const stage = result.apiStages.find((item) => item.name === "resolveWorkflowParticipants");
    const warning = result.diagnostics.find((item) => (
      item.code === "workflow.participant_direct_override_applied"
    ));

    assert.equal(result.ok, true);
    assert.equal(result.status, "written_with_warnings");
    assert.deepEqual(members.map(({ id, name }) => ({ id, name })), [{
      id: targetFdId,
      name: "admin-ce"
    }]);
    assert.equal(stage.directOverrideCount, 1);
    assert.equal(stage.directOverrideIdentityCount, 1);
    assert.deepEqual(stage.directOverrideTargetIds, [targetFdId]);
    assert.equal(stage.directOverrides[0].sourceTargetEvidence.fdId, sourceTargetId);
    assert.equal(stage.directOverrides[0].target.fdId, targetFdId);
    assert.equal(warning.details.referenceCount, 1);
    assert.equal(warning.details.overrides[0].sourceTargetEvidence.fdName, "郑汉敏");
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [[targetFdId]]);
  });

  it("persists a structured fixed-post target without searching or falling back to a source id", async () => {
    const targetFdId = "current-structured-post";
    const dsl = dslWithExplicitMembers([{
      id: targetFdId,
      name: "采购部_采购岗",
      type: "user_or_org",
      targetOrgType: 4
    }]);
    const client = new CompleteSearchClient({}, {
      [targetFdId]: [currentOrg({
        fdId: targetFdId,
        fdName: "采购部_采购岗",
        fdOrgType: 4
      })]
    });

    const result = await executeDsl(dsl, {
      client,
      credentials: { username: "route-user", encryptedPassword: "route-password" },
      confirmWrite: true,
      targetCategoryId: "category-1",
      now: new Date("2026-08-23T00:00:00.000Z")
    });
    const workflow = JSON.parse(client.savedTemplate.mechanisms.lbpmTemplate[0].fdContent);
    const members = workflow.elements.find((element) => element.id === "N-review").handlers.members;

    assert.equal(result.ok, true);
    assert.deepEqual(members, [{
      id: targetFdId,
      name: "采购部_采购岗",
      element: "user",
      type: "2"
    }]);
    assert.deepEqual(client.calls, []);
    assert.deepEqual(client.elementCalls, [[targetFdId]]);
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
      orgType: 60,
      paramAvailable: 1,
      addressRange: [1],
      searchMode: "FUZZY"
    });
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(result.map((item) => item.fdId), ["person-1"]);
  });

  it("narrows current organization search to the source org type when provided", async () => {
    const calls = [];
    const client = new NewoaClient({
      baseUrl: NEWOA_SIT_BASE_URL,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({ success: true, data: [] });
      }
    });
    client.token = "test-token";

    await client.searchOrg("环保集团本部（机电院）运营管理中心_部门领导", 4);

    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].options.body).orgType, 4);
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
    this.searchRequests = [];
    this.elementCalls = [];
    this.executeCalls = [];
  }

  async login() {
    this.executeCalls.push("login");
    return { ok: true };
  }

  async assertTransferRecordAuthentication() {}

  async addTransferRecord(payload) {
    this.executeCalls.push("addTransferRecord");
    return { fdId: payload.fdId };
  }

  async searchOrg(name, sourceOrgType) {
    this.calls.push(name);
    this.searchRequests.push({ key: name, sourceOrgType });
    return structuredClone(this.results[name] || []);
  }

  async getElementInfo(targets) {
    this.elementCalls.push(structuredClone(targets));
    return targets.flatMap((targetId) => structuredClone(this.elementResults[targetId] || []));
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

function sitFallbackElementResults() {
  return Object.fromEntries(
    Object.values(SIT_PARTICIPANT_FALLBACKS).map((fallback) => [
      fallback.fdId,
      [currentOrg({
        fdId: fallback.fdId,
        fdName: fallback.fdName,
        fdOrgType: fallback.fdOrgType
      })]
    ])
  );
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
