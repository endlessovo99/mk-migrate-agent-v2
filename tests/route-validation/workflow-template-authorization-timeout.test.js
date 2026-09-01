import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { NEWOA_SIT_BASE_URL } from "../../src/executor/newoa-client.js";
import { resolveWorkflowParticipants } from "../../src/executor/participant-resolver.js";
import {
  persistAndVerify,
  sampleBaseTemplate
} from "../helpers/persistence.js";
import {
  cleanSourceFile,
  draftSourceDraft
} from "../../src/translator/index.js";

const sourcePath = "tests/fixtures/source3/1790be7c892fe3023c8de49407782b79";
const checkedAt = "2026-08-30T00:00:00.000Z";

describe("workflow-template authorization and timeout Route case", () => {
  it("preserves source template authorization and the standard 15-day privileged-user notification", async () => {
    const sourceDraft = cleanSourceFile(sourcePath);
    const dslDraft = draftSourceDraft(sourceDraft);

    assert.deepEqual(permissionCounts(sourceDraft.template.authorization), {
      readers: 2,
      editors: 3,
      allReaders: 3,
      allEditors: 3,
      temporaryReaders: 1,
      temporaryEditors: 0
    });
    assert.equal(sourceDraft.template.authorization.readerFlag, false);
    assert.deepEqual(dslDraft.workflow.process.timeoutNotification, {
      afterDays: 15,
      afterHours: 0,
      afterMinutes: 0,
      recipient: "privileged_users",
      notifyMethods: ["todo"]
    });
    assert.deepEqual(
      dslDraft.template.authorization.temporaryReaders.map((member) => ({
        sourceId: member.sourceId,
        name: member.name,
        sourceOrgType: member.sourceOrgType,
        sourceParentName: member.sourceParentName
      })),
      [{
        sourceId: "186318a9441daf6bae773e5440db7d69",
        name: "电气数科_总经理",
        sourceOrgType: 4,
        sourceParentName: "电气数科公司领导"
      }]
    );

    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt
    });
    const resolved = await resolveWorkflowParticipants(trusted, {
      client: permissionResolutionClient(trusted)
    });
    const result = persistAndVerify(resolved.dsl, {
      baseTemplate: sampleBaseTemplate({
        fdReaderFlag: true,
        fdNotReaderFlag: false,
        fdReaders: [],
        fdAllReaders: [{ fdId: "all-users", fdName: "所有用户" }],
        fdEditors: [],
        fdAllEditors: [],
        fdTmpReaders: [],
        fdTmpEditors: []
      })
    });

    assert.equal(result.readback.ok, true, JSON.stringify(result.readback.diagnostics));
    assert.equal(result.template.fdReaderFlag, true);
    assert.deepEqual(result.template.fdReaders.map((member) => member.fdId), [
      "target-person-101-EKP-SUXL",
      "target-person-10101328"
    ]);
    assert.deepEqual(result.template.fdEditors.map((member) => member.fdId), [
      "target-person-683-SYS-ZKY",
      "target-person-10101328",
      "target-person-101-EKP-SUXL"
    ]);
    assert.deepEqual(result.template.fdTmpReaders.map((member) => member.fdId), [
      "target-post-general-manager"
    ]);
    assert.deepEqual(result.template.fdTmpEditors, []);

    const lbpm = result.template.mechanisms.lbpmTemplate[0];
    assert.deepEqual(lbpm.fdReaders, result.template.fdReaders);
    assert.deepEqual(lbpm.fdEditors, result.template.fdEditors);
    assert.equal(lbpm.fdTimeoutStrategiesOfNode.length, 1);
    assertStandardTimeoutStrategy(lbpm.fdTimeoutStrategiesOfNode[0]);
    assert.deepEqual(result.readback.workflow.timeoutNotification, {
      afterDays: 15,
      afterHours: 0,
      afterMinutes: 0,
      recipient: "privileged_users",
      notifyMethods: ["todo"]
    });
    assert.deepEqual(result.readback.workflow.templateAuthorization, {
      readers: ["target-person-101-EKP-SUXL", "target-person-10101328"].sort(),
      editors: [
        "target-person-683-SYS-ZKY",
        "target-person-10101328",
        "target-person-101-EKP-SUXL"
      ].sort(),
      allReaders: [
        "target-person-683-SYS-ZKY",
        "target-person-101-EKP-SUXL",
        "target-person-10101328"
      ].sort(),
      allEditors: [
        "target-person-683-SYS-ZKY",
        "target-person-10101328",
        "target-person-101-EKP-SUXL"
      ].sort(),
      temporaryReaders: ["target-post-general-manager"],
      temporaryEditors: []
    });

    const serverNormalized = structuredClone(result.template);
    const normalizedStrategy = serverNormalized.mechanisms.lbpmTemplate[0]
      .fdTimeoutStrategiesOfNode[0];
    delete normalizedStrategy.fdCondition;
    for (const action of normalizedStrategy.fdActions) {
      delete action.fdActionTypeErrorStatus;
      delete action.processErrorStatus;
      delete action.notifyMethodsErrorStatus;
      delete action.fdMessageContentErrorStatus;
      delete action.notifyTemplateCodeErrorStatus;
      delete action.customNotifyContentErrorStatus;
    }
    const normalizedReadback = result.prepared.verify(serverNormalized);
    assert.equal(
      normalizedReadback.ok,
      true,
      JSON.stringify(normalizedReadback.diagnostics)
    );
  });

  it("uses the configured post fallback for an explicitly authorized unresolved default reader", async () => {
    const sourceDraft = cleanSourceFile(sourcePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt
    });
    const fallbackPostId = "configured-template-permission-fallback-post";
    const baseClient = permissionResolutionClient(trusted);
    const client = {
      async searchOrg(key, orgType) {
        if (Number(orgType) === 4) return [];
        return baseClient.searchOrg(key, orgType);
      },
      async getElementInfo(targets) {
        return [
          ...await baseClient.getElementInfo(targets),
          ...targets.filter((target) => target === fallbackPostId).map(() => ({
            fdId: fallbackPostId,
            fdName: "配置模版权限兜底岗位",
            fdOrgType: 4
          }))
        ];
      }
    };

    const resolved = await resolveWorkflowParticipants(trusted, {
      client,
      targetBaseUrl: NEWOA_SIT_BASE_URL,
      fallbackFdIds: { post: fallbackPostId },
      allowTemplateAuthorizationFallback: true
    });
    const result = persistAndVerify(resolved.dsl);

    assert.equal(result.readback.ok, true, JSON.stringify(result.readback.diagnostics));
    assert.deepEqual(
      result.template.fdTmpReaders.map((member) => member.fdId),
      [fallbackPostId]
    );
    assert.equal(resolved.fallbackCount, 1);
    assert.equal(resolved.fallbackIdentityCount, 1);
    assert.deepEqual(resolved.fallbackTargetIds, [fallbackPostId]);
  });

  it("preserves a parentless default reader through a separately scoped exact override", async () => {
    const sourceDraft = cleanSourceFile(sourcePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const sourceMember = sourceDraft.template.authorization.temporaryReaders[0];
    const dslMember = dslDraft.template.authorization.temporaryReaders[0];
    delete sourceMember.sourceParentName;
    delete dslMember.sourceParentName;
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt
    });
    const baseClient = permissionResolutionClient(trusted);
    const searchCalls = [];
    const client = {
      async searchOrg(key, orgType) {
        searchCalls.push({ key, orgType });
        return baseClient.searchOrg(key, orgType);
      },
      async getElementInfo(targets) {
        const remaining = targets.filter((target) => target !== sourceMember.sourceId);
        return [
          ...(remaining.length ? await baseClient.getElementInfo(remaining) : []),
          ...(targets.includes(sourceMember.sourceId) ? [{
            fdId: sourceMember.sourceId,
            fdName: sourceMember.name,
            fdOrgType: sourceMember.sourceOrgType
          }] : [])
        ];
      }
    };

    const resolved = await resolveWorkflowParticipants(trusted, {
      client,
      templateAuthorizationOverrides: [{
        sourceId: sourceMember.sourceId,
        targetFdId: sourceMember.sourceId
      }]
    });
    const result = persistAndVerify(resolved.dsl);

    assert.equal(result.readback.ok, true, JSON.stringify(result.readback.diagnostics));
    assert.deepEqual(result.template.fdTmpReaders.map((member) => member.fdId), [
      sourceMember.sourceId
    ]);
    assert.equal(resolved.templateAuthorizationOverrideCount, 1);
    assert.equal(resolved.templateAuthorizationOverrideIdentityCount, 1);
    assert.deepEqual(resolved.templateAuthorizationOverrides[0].paths, [
      "/template/authorization/temporaryReaders/0"
    ]);
    assert.equal(
      searchCalls.some((call) => call.key === sourceMember.name && Number(call.orgType) === 4),
      false
    );
  });

  it("retains all-scope-only authorization members through NewOA normalization", async () => {
    const sourceDraft = cleanSourceFile(sourcePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt
    });
    const resolved = await resolveWorkflowParticipants(trusted, {
      client: permissionResolutionClient(trusted)
    });
    const allReaderAndEditor = resolved.dsl.template.authorization.allReaders[0];
    const allReaderOnly = {
      ...allReaderAndEditor,
      id: "target-person-all-reader-only",
      name: "仅全局阅读者"
    };
    resolved.dsl.template.authorization = {
      ...resolved.dsl.template.authorization,
      readers: [],
      editors: [],
      allReaders: [allReaderOnly, allReaderAndEditor],
      allEditors: [allReaderAndEditor],
      temporaryReaders: [],
      temporaryEditors: []
    };
    const originalAuthorization = structuredClone(resolved.dsl.template.authorization);
    const result = persistAndVerify(resolved.dsl);
    const serverNormalized = normalizeAuthorizationLikeNewoa(result.template);

    const readback = result.prepared.verify(serverNormalized);

    assert.deepEqual(resolved.dsl.template.authorization, originalAuthorization);
    assert.deepEqual(result.template.fdReaders.map((member) => member.fdId), [
      allReaderOnly.id
    ]);
    assert.deepEqual(result.template.fdEditors.map((member) => member.fdId), [
      allReaderAndEditor.id
    ]);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.deepEqual(readback.workflow.templateAuthorization.allReaders, [
      allReaderOnly.id,
      allReaderAndEditor.id
    ].sort());
    assert.deepEqual(readback.workflow.templateAuthorization.allEditors, [
      allReaderAndEditor.id
    ]);
  });
});

function normalizeAuthorizationLikeNewoa(template) {
  const next = structuredClone(template);
  const baseIds = new Set([
    ...(next.fdReaders || []).map((member) => member.fdId),
    ...(next.fdEditors || []).map((member) => member.fdId)
  ]);
  next.fdAllReaders = (next.fdAllReaders || []).filter((member) => baseIds.has(member.fdId));
  next.fdAllEditors = (next.fdAllEditors || []).filter((member) => baseIds.has(member.fdId));
  return next;
}

function permissionCounts(authorization = {}) {
  return Object.fromEntries([
    "readers",
    "editors",
    "allReaders",
    "allEditors",
    "temporaryReaders",
    "temporaryEditors"
  ].map((key) => [key, authorization[key]?.length || 0]));
}

function permissionResolutionClient(dsl) {
  const people = new Map([
    ["683-SYS-ZKY", person("683-SYS-ZKY")],
    ["10101328", person("10101328")],
    ["101-EKP-SUXL", person("101-EKP-SUXL")]
  ]);
  const directTargets = new Map(
    (dsl.workflow?.nodes || []).flatMap((node) => [
      ...(node.participants?.members || []),
      ...(node.participants?.alternativeMembers || [])
    ]).filter((member) => member?.id || member?.sourceId).map((member) => [
      member.id || member.sourceId,
      {
      fdId: member.id || member.sourceId,
      fdName: member.name,
      fdOrgType: member.targetOrgType || member.sourceOrgType || 8
    }])
  );
  return {
    async searchOrg(key, orgType) {
      if (Number(orgType) === 8 && people.has(key)) return [people.get(key)];
      if (Number(orgType) === 4 && key === "总经理") {
        return [{
          fdId: "target-post-general-manager",
          fdName: "总经理",
          fdOrgType: 4,
          fdParentName: "电气数科公司领导"
        }];
      }
      return [];
    },
    async getElementInfo(targets) {
      return targets.flatMap((target) => directTargets.get(target) || []);
    }
  };
}

function person(loginName) {
  return {
    fdId: `target-person-${loginName}`,
    fdName: `目标人员-${loginName}`,
    fdOrgType: 8,
    fdLoginName: loginName
  };
}

function assertStandardTimeoutStrategy(strategy) {
  assert.match(strategy.fdKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(strategy.fdName, "15天未完成通知特权人");
  assert.equal(strategy.fdTimeoutType, 2);
  assert.equal(strategy.fdDayOfTimeout, 15);
  assert.equal(strategy.fdHourOfTimeout, 0);
  assert.equal(strategy.fdMinuteOfTimeout, 0);
  assert.equal(strategy.fdExpireDuration, 21600);
  assert.deepEqual(strategy.fdCondition, {
    fdTimeoutType: 2,
    fdDayOfTimeout: 15,
    fdHourOfTimeout: 0,
    fdMinuteOfTimeout: 0,
    fdExpireDuration: 21600
  });
  assert.equal(strategy.fdActions.length, 1);
  const action = strategy.fdActions[0];
  assert.deepEqual({
    fdActionType: action.fdActionType,
    fdRepeat: action.fdRepeat,
    fdActionTypeErrorStatus: action.fdActionTypeErrorStatus,
    processErrorStatus: action.processErrorStatus,
    notifyMethodsErrorStatus: action.notifyMethodsErrorStatus,
    fdMessageContentErrorStatus: action.fdMessageContentErrorStatus,
    notifyTemplateCodeErrorStatus: action.notifyTemplateCodeErrorStatus,
    customNotifyContentErrorStatus: action.customNotifyContentErrorStatus
  }, {
    fdActionType: "notifyAdmin",
    fdRepeat: false,
    fdActionTypeErrorStatus: false,
    processErrorStatus: false,
    notifyMethodsErrorStatus: false,
    fdMessageContentErrorStatus: true,
    notifyTemplateCodeErrorStatus: false,
    customNotifyContentErrorStatus: false
  });
  const title = "节点超时通知：#{nodeName}超过#{day}天#{hour}小时#{minute}分钟未处理，请关注！流程名称“#{subject}”";
  assert.deepEqual(JSON.parse(action.fdConfig), {
    notifyMethods: ["todo"],
    fdMessageContent: {
      msgType: 3,
      notifyTitle: {
        language: {
          "zh-cn": {
            value: title,
            display: title
          }
        }
      }
    }
  });
}
