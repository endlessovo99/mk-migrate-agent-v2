import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { inspectSubProcessStartParamCompatibility } from "../../src/dsl/subprocess.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { NEWOA_SIT_BASE_URL } from "../../src/executor/newoa-client.js";
import {
  ParticipantResolutionError,
  resolveWorkflowParticipants
} from "../../src/executor/participant-resolver.js";
import {
  resolveSubProcessTemplates,
  SubProcessTemplateResolutionError
} from "../../src/executor/subprocess-template-resolver.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { persistAndVerify } from "../helpers/persistence.js";

const source4 = (id) => `tests/fixtures/source4/${id}`;
const checkedAt = "2026-09-01T00:00:00.000Z";

describe("Source4 workflow write gates", () => {
  it("maps an all split paired with an anyone join through trust and dry-run", () => {
    const sourceDraft = cleanSourceFile(source4("16c509ab5573914bf32f59e420a932ea"));
    const dslDraft = draftSourceDraft(sourceDraft);
    const split = dslDraft.workflow.nodes.find((node) => node.id === "N27");
    const join = dslDraft.workflow.nodes.find((node) => node.id === "N28");

    assert.equal(split.definition.attributes.splitType, "all");
    assert.equal(join.definition.attributes.joinType, "anyone");
    assert.equal(split.translationStatus, "executable");
    assert.equal(join.translationStatus, "executable");

    const trusted = trustSourceDraft(sourceDraft, dslDraft);
    assert.equal(buildDryRunPlan(trusted).ok, true);
  });

  it("closes every all/anyone gateway in the larger Source4 workflow through dry-run", () => {
    const sourceDraft = cleanSourceFile(source4("17af0f6388dd27ab1d7d54543f0886fa"));
    const dslDraft = draftSourceDraft(sourceDraft);
    const gateways = dslDraft.workflow.nodes.filter((node) =>
      ["split", "join"].includes(node.type)
    );

    assert.equal(gateways.length, 12);
    assert.equal(gateways.every((node) => node.translationStatus === "executable"), true);

    const trusted = trustSourceDraft(sourceDraft, dslDraft);
    assert.equal(buildDryRunPlan(trusted).ok, true);
  });

  it("retains complete source identities when only the parent-name lookup hint is absent", () => {
    const cases = [
      {
        id: "16f7a2202ee38ad5b25e46e4905a56e4",
        parentless: [
          ["14912dbcc14f6f86401f11247c88d944", "电站信息技术部_部长"],
          ["14912dbce205406580511a34abb888ea", "电站信息技术部_分管领导"]
        ]
      },
      {
        id: "173a2a714308e399f1a115f4e3fa556e",
        parentless: [
          ["14912dbccbb659c70fea14c4319bd1c9", "电气集团数字和信息化部_部长"]
        ]
      }
    ];

    for (const testCase of cases) {
      const sourceDraft = cleanSourceFile(source4(testCase.id));
      const dslDraft = draftSourceDraft(sourceDraft);
      const temporaryReaders = sourceDraft.template.authorization.temporaryReaders;

      assert.deepEqual(
        testCase.parentless.map(([sourceId, name]) => {
          const member = temporaryReaders.find((candidate) => candidate.sourceId === sourceId);
          return {
            sourceId: member?.sourceId,
            name: member?.name,
            sourceOrgType: member?.sourceOrgType,
            sourceOrgClass: member?.sourceOrgClass,
            sourceParentName: member?.sourceParentName
          };
        }),
        testCase.parentless.map(([sourceId, name]) => ({
          sourceId,
          name,
          sourceOrgType: 4,
          sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgPost",
          sourceParentName: undefined
        }))
      );
      assert.equal(sourceDraft.issues.some((item) =>
        item.code === "source.template.authorization_identity_incomplete"
      ), false);
      assert.equal(checkDraft(dslDraft).ok, true);
      const trusted = trustSourceDraft(sourceDraft, dslDraft);
      assert.equal(buildDryRunPlan(trusted).ok, true);
    }
  });

  it("keeps parentless template posts fail-closed unless exact-id validation or template fallback is explicit", async () => {
    const exactSource = cleanSourceFile(source4("16f7a2202ee38ad5b25e46e4905a56e4"));
    const exactMember = exactSource.template.authorization.temporaryReaders.find((member) =>
      member.sourceId === "14912dbcc14f6f86401f11247c88d944"
    );
    const exactDsl = trustedDslWithTemporaryReader(exactMember);
    const exact = await resolveWorkflowParticipants(exactDsl, {
      client: exactElementClient({
        fdId: exactMember.sourceId,
        fdName: exactMember.name,
        fdOrgType: 4
      }),
      templateAuthorizationOverrides: [{
        sourceId: exactMember.sourceId,
        targetFdId: exactMember.sourceId
      }]
    });
    assert.equal(exact.dsl.template.authorization.temporaryReaders[0].id, exactMember.sourceId);
    assert.equal(exact.templateAuthorizationOverrideIdentityCount, 1);

    const renamedSource = cleanSourceFile(source4("173a2a714308e399f1a115f4e3fa556e"));
    const renamedMember = renamedSource.template.authorization.temporaryReaders.find((member) =>
      member.sourceId === "14912dbccbb659c70fea14c4319bd1c9"
    );
    const renamedDsl = trustedDslWithTemporaryReader(renamedMember);
    const fallbackId = "configured-parentless-template-post";
    const fallbackClient = exactElementClient({
      fdId: fallbackId,
      fdName: "配置模版权限兜底岗位",
      fdOrgType: 4
    });

    await assert.rejects(
      resolveWorkflowParticipants(renamedDsl, {
        client: fallbackClient,
        targetBaseUrl: NEWOA_SIT_BASE_URL,
        fallbackFdIds: { post: fallbackId }
      }),
      (error) => error instanceof ParticipantResolutionError &&
        error.issues.some((issue) => issue.reason === "missing_source_evidence")
    );

    const fallback = await resolveWorkflowParticipants(renamedDsl, {
      client: fallbackClient,
      targetBaseUrl: NEWOA_SIT_BASE_URL,
      fallbackFdIds: { post: fallbackId },
      allowTemplateAuthorizationFallback: true
    });
    assert.equal(fallback.dsl.template.authorization.temporaryReaders[0].id, fallbackId);
    assert.equal(fallback.fallbackIdentityCount, 1);
  });

  it("maps the standalone legacy subprocess to NewOA continue-flow semantics", async () => {
    const sourceDraft = cleanSourceFile(source4("173a2a714308e399f1a115f4e3fa556e"));
    const dslDraft = draftSourceDraft(sourceDraft);
    const node = dslDraft.workflow.nodes.find((candidate) => candidate.id === "N14");

    assert.equal(node.type, "startSubProcess");
    assert.equal(node.translationStatus, "executable");
    assert.equal(node.subProcess.sourceTemplateId, "14f81cdd2cb9798ae66e25346f8adf83");
    assert.equal(node.subProcess.templateId, undefined);
    assert.equal(node.subProcess.flowType, "1");
    assert.equal(node.subProcess.startCountType, "1");
    assert.equal(node.subProcess.autoSubmit, false);
    assert.equal(node.subProcess.recoverNodeId, undefined);
    assert.deepEqual(node.subProcess.recoverParamConfig, []);
    assert.equal(node.subProcess.startParamConfig.length, 14);
    assert.deepEqual(node.subProcess.startIdentity, {
      mode: "explicit",
      members: [{
        type: "user_or_org",
        sourceId: "16a2e6340d037bfb1d64c9042d486835",
        name: "张康永",
        sourceOrgType: 8,
        sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgPerson"
      }],
      sourceSemantics: "legacy_start_identity_type_3"
    });

    const trusted = trustSourceDraft(sourceDraft, dslDraft);
    assert.equal(buildDryRunPlan(trusted).ok, true);

    trusted.template.authorization = emptyAuthorization();
    for (const workflowNode of trusted.workflow.nodes) {
      if (workflowNode.id !== "N14" && workflowNode.participants) {
        workflowNode.participants = {
          mode: "empty",
          reason: "isolated standalone subprocess persistence contract"
        };
      }
    }
    const fallbackId = "configured-subprocess-starter";
    const childTargetId = "migrated-child-template";
    const client = {
      ...exactElementClient({
        fdId: fallbackId,
        fdName: "配置子流程起草人",
        fdOrgType: 8
      }),
      async getTemplate(fdId) {
        return fdId === childTargetId
          ? { fdId, fdName: "MK_TEST_集团IT系统帐号关闭流程" }
          : undefined;
      }
    };
    await assert.rejects(
      resolveSubProcessTemplates(trusted, { client }),
      (error) => error instanceof SubProcessTemplateResolutionError &&
        error.issues.some((issue) => issue.reason === "subprocess_template_override_required")
    );
    const templateOverrides = [{
      sourceTemplateId: "14f81cdd2cb9798ae66e25346f8adf83",
      targetFdId: childTargetId
    }];
    await assert.rejects(
      resolveSubProcessTemplates(trusted, { client, overrides: templateOverrides }),
      (error) => error instanceof SubProcessTemplateResolutionError &&
        error.issues.some((issue) =>
          issue.reason === "subprocess_start_parameter_contract_unverified" &&
          issue.targetParameters.length === 14
        )
    );

    const isolatedProjectionDsl = structuredClone(trusted);
    isolatedProjectionDsl.workflow.nodes.find((candidate) => candidate.id === "N14")
      .subProcess.startParamConfig = [];
    const targetResolved = await resolveSubProcessTemplates(isolatedProjectionDsl, {
      client,
      overrides: templateOverrides
    });
    assert.equal(targetResolved.resolvedCount, 1);
    assert.deepEqual(targetResolved.targetFdIds, [childTargetId]);

    const resolved = await resolveWorkflowParticipants(targetResolved.dsl, {
      client,
      targetBaseUrl: NEWOA_SIT_BASE_URL,
      fallbackFdIds: { person: fallbackId }
    });
    assert.equal(
      resolved.dsl.workflow.nodes.find((candidate) => candidate.id === "N14")
        .subProcess.startIdentity.members[0].id,
      fallbackId
    );
    assert.equal(resolved.fallbackIdentityCount, 1);

    const result = persistAndVerify(resolved.dsl);
    assert.equal(result.readback.ok, true, JSON.stringify(result.readback.diagnostics));
    const workflow = JSON.parse(result.template.mechanisms.lbpmTemplate[0].fdContent);
    const nativeNode = workflow.elements.find((element) => element.id === "N14");
    assert.equal(nativeNode.flowType, "1");
    assert.equal(JSON.parse(nativeNode.config).subProcess.templateId, childTargetId);
    assert.deepEqual(nativeNode.startIdentity.members.map(({ id, name, type }) => ({ id, name, type })), [{
      id: fallbackId,
      name: "配置子流程起草人",
      type: "1"
    }]);

    const mutated = structuredClone(result.template);
    const mutatedWorkflow = JSON.parse(mutated.mechanisms.lbpmTemplate[0].fdContent);
    mutatedWorkflow.elements.find((element) => element.id === "N14")
      .startIdentity.members[0].id = "wrong-subprocess-starter";
    mutated.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(mutatedWorkflow);
    const mutatedReadback = result.prepared.verify(mutated);
    assert.equal(mutatedReadback.ok, false);
    assert.equal(mutatedReadback.diagnostics.some((item) =>
      item.code === "readback.workflow.subprocess_mismatch"
    ), true);
  });

  it("keeps the same-name child migration blocked when its current input contract is incompatible", () => {
    const parent = draftSourceDraft(
      cleanSourceFile(source4("173a2a714308e399f1a115f4e3fa556e"))
    );
    const child = draftSourceDraft(
      cleanSourceFile("tests/fixtures/source/1642fc12fcc6b13748dde7a4852896a7")
    );
    const subProcess = parent.workflow.nodes.find((node) => node.id === "N14").subProcess;
    const issues = inspectSubProcessStartParamCompatibility(subProcess, child);

    assert.equal(child.template.name, "集团IT系统帐号关闭流程");
    assert.equal(subProcess.startParamConfig.length, 14);
    assert.equal(issues.some((issue) => issue.targetId === "docSubject"), false);
    assert.deepEqual(
      [...new Set(issues.map((issue) => issue.code))],
      ["subprocess.start_param_target_missing"]
    );
    assert.equal(issues.length, 13);
    assert.equal(issues.every((issue) =>
      issue.targetId.startsWith("fd_3242f3c67e44fc.")
    ), true);
    assert.equal(
      child.form.fields.some((field) => field.id === "fd_close_account"),
      true
    );
    assert.deepEqual(
      ["fd_xz_name", "fd_sel_dept", "fd_input_post"].filter((columnId) =>
        !child.form.fields.find((field) => field.id === "fd_close_account")
          .columns.some((column) => column.id === columnId)
      ),
      ["fd_xz_name", "fd_sel_dept", "fd_input_post"]
    );
  });

  it("keeps the first-child department leader formula blocked without a proven target child-enumeration API", () => {
    const sourceDraft = cleanSourceFile(source4("16a6ba4ef79b003d8edf44c4f8888149"));
    const dslDraft = draftSourceDraft(sourceDraft);
    const node = dslDraft.workflow.nodes.find((candidate) => candidate.id === "N11");
    const webhook = dslDraft.workflow.nodes.find((candidate) => candidate.id === "N17");

    assert.equal(node.participants.mode, "unmapped_formula");
    assert.equal(node.participants.formulaFamily, "other");
    assert.match(node.participants.sourceExpression, /getFdChildren\(\)/);
    assert.match(node.participants.sourceExpression, /children\.get\(0\)\.getLeader\(0\)/);
    assert.equal(node.translationStatus, "pending_review");
    assert.equal(webhook.type, "review");
    assert.equal(webhook.element, "manualTask");
    assert.equal(webhook.translationStatus, "pending_review");
    assert.equal(webhook.sourceType, "webhookNode");
    assert.equal(webhook.definition.attributes.content.includes("__REDACTED_CREDENTIAL__"), true);

    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt
    });
    const trust = checkTrust(sourceDraft, trusted);
    assert.equal(trust.ok, false);
    assert.equal(trust.diagnostics.some((item) =>
      item.code === "dsl.workflow.node.pending_review" &&
      item.path === "/workflow/nodes/14/translationStatus"
    ), true, JSON.stringify(trust.diagnostics));
    assert.equal(buildDryRunPlan(trusted).ok, false);
  });
});

function trustSourceDraft(sourceDraft, dslDraft) {
  const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
    externalAgentReviewed: true,
    reviewerName: "route-validation",
    checkedAt
  });
  const trust = checkTrust(sourceDraft, trusted);
  assert.equal(trust.ok, true, JSON.stringify(trust.diagnostics));
  return trusted;
}

function trustedDslWithTemporaryReader(member) {
  return sampleTrustedDsl({
    template: {
      authorization: {
        readerFlag: false,
        readers: [],
        editors: [],
        allReaders: [],
        allEditors: [],
        temporaryReaders: [member],
        temporaryEditors: []
      }
    }
  });
}

function exactElementClient(element) {
  return {
    async searchOrg() {
      throw new Error("parentless source evidence must not be guessed by name search");
    },
    async getElementInfo(targets) {
      return targets.includes(element.fdId) ? [element] : [];
    }
  };
}

function emptyAuthorization() {
  return {
    readerFlag: false,
    readers: [],
    editors: [],
    allReaders: [],
    allEditors: [],
    temporaryReaders: [],
    temporaryEditors: []
  };
}
