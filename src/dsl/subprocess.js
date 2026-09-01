export function projectSubProcessWorkflow(workflow = {}) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const recoverById = new Map(nodes
    .filter((node) => node?.type === "recoverSubProcess")
    .map((node) => [node.id, node]));
  const startByRecoverId = new Map(nodes
    .filter((node) => node?.type === "startSubProcess" && node.subProcess?.recoverNodeId)
    .map((node) => [node.subProcess.recoverNodeId, node]));

  if (!recoverById.size) return { nodes, edges, recoveries: [] };

  const projectedNodes = nodes.filter((node) => !recoverById.has(node.id));
  const projectedEdges = [];
  for (const edge of edges) {
    if (recoverById.has(edge.target) && startByRecoverId.get(edge.target)?.id === edge.source) {
      continue;
    }
    const pairedStart = startByRecoverId.get(edge.source);
    projectedEdges.push(pairedStart ? { ...edge, source: pairedStart.id } : edge);
  }

  return {
    nodes: projectedNodes,
    edges: projectedEdges,
    recoveries: [...recoverById.values()].map((recover) => ({
      recoverNodeId: recover.id,
      startNodeId: recover.subProcess?.startNodeId || ""
    }))
  };
}

export function subProcessContract(value = {}) {
  const startIdentity = subProcessStartIdentityContract(value.startIdentity);
  return {
    templateId: value.templateId,
    recoverNodeId: value.recoverNodeId,
    startCountType: String(value.startCountType || "1"),
    flowType: String(value.flowType || "2"),
    autoSubmit: value.autoSubmit === true,
    recovery: {
      variableScope: value.variableScope,
      recoverRule: value.recoverRule
    },
    ...(startIdentity ? { startIdentity } : {}),
    startParamConfig: Array.isArray(value.startParamConfig) ? value.startParamConfig : [],
    recoverParamConfig: Array.isArray(value.recoverParamConfig) ? value.recoverParamConfig : []
  };
}

export function inspectSubProcessStartParamCompatibility(subProcess = {}, childDsl = {}) {
  const targetFields = childTargetFieldContracts(childDsl?.form);
  return (Array.isArray(subProcess.startParamConfig) ? subProcess.startParamConfig : [])
    .flatMap((mapping, index) => {
      const target = mapping?.target || {};
      const targetId = String(target.value || "").trim();
      const expected = legacyTypeContract(target.type);
      const actual = targetFields.get(targetId);
      const path = `/subProcess/startParamConfig/${index}/target`;
      if (!targetId || !expected) {
        return [{
          code: "subprocess.start_param_target_invalid",
          path,
          targetId,
          targetType: target.type
        }];
      }
      if (!actual) {
        return [{
          code: "subprocess.start_param_target_missing",
          path,
          targetId,
          expected
        }];
      }
      const issues = [];
      if (actual.type !== expected.type) {
        issues.push({
          code: "subprocess.start_param_target_type_mismatch",
          path,
          targetId,
          expected: expected.type,
          actual: actual.type
        });
      }
      if (actual.array !== expected.array) {
        issues.push({
          code: "subprocess.start_param_target_grain_mismatch",
          path,
          targetId,
          expected: expected.array ? "array" : "scalar",
          actual: actual.array ? "array" : "scalar"
        });
      }
      return issues;
    });
}

function childTargetFieldContracts(form = {}) {
  const contracts = new Map([["docSubject", { type: "String", array: false }]]);
  for (const field of Array.isArray(form?.fields) ? form.fields : []) {
    if (field?.type === "detailTable") {
      for (const column of field.columns || []) {
        contracts.set(`${field.id}.${column.id}`, {
          type: dslFieldLegacyType(column),
          array: true
        });
      }
      continue;
    }
    contracts.set(field.id, { type: dslFieldLegacyType(field), array: false });
  }
  return contracts;
}

function dslFieldLegacyType(field = {}) {
  if (field.componentId === "xform-address") {
    return "com.landray.kmss.sys.organization.model.SysOrgElement";
  }
  if (field.type === "dateTime") return "Date";
  return "String";
}

function legacyTypeContract(value) {
  const text = String(value || "").trim();
  if (!text) return undefined;
  const array = text.endsWith("[]");
  return {
    type: array ? text.slice(0, -2) : text,
    array
  };
}

function subProcessStartIdentityContract(value) {
  if (!isRecord(value)) return undefined;
  if (value.mode === "explicit" && Array.isArray(value.members)) {
    return {
      mode: "explicit",
      members: value.members.map((member) => ({
        id: member?.id,
        name: member?.name,
        targetOrgType: member?.targetOrgType
      }))
    };
  }
  if (
    String(value.type || "").toLowerCase() === "org" &&
    Array.isArray(value.members) &&
    value.members.length > 0
  ) {
    return {
      mode: "explicit",
      members: value.members.map((member) => ({
        id: member?.id,
        name: member?.name,
        targetOrgType: nativeMemberOrgType(member?.type)
      }))
    };
  }
  return undefined;
}

function nativeMemberOrgType(value) {
  const type = String(value || "");
  if (type === "1") return 8;
  if (type === "2") return 4;
  if (type === "4") return 32;
  return 2;
}

export function subProcessValidationIssues({ nodes = [], edges = [], mode = "draft" } = {}) {
  if (!Array.isArray(nodes)) return [];
  const issues = [];
  const nodeMap = new Map(nodes.filter(isRecord).map((node) => [node.id, node]));
  for (const [index, node] of nodes.entries()) {
    if (!isRecord(node) || !["startSubProcess", "recoverSubProcess"].includes(node.type)) continue;
    const path = `/workflow/nodes/${index}`;
    if (node.element !== "subProcess") {
      issues.push(issue("error", "dsl.workflow.subprocess.element_required", "Subprocess nodes must use element = subProcess.", `${path}/element`));
    }
    if (!isRecord(node.subProcess)) {
      issues.push(issue(
        mode === "execute" ? "error" : "warning",
        "dsl.workflow.subprocess.config_required",
        "Subprocess nodes require structured subProcess configuration before execution.",
        `${path}/subProcess`
      ));
      continue;
    }
    if (node.type === "startSubProcess") {
      const recoverId = node.subProcess.recoverNodeId;
      const hasTargetTemplate = nonEmptyString(node.subProcess.templateId);
      const hasSourceTemplate = nonEmptyString(node.subProcess.sourceTemplateId);
      if (!hasTargetTemplate && !hasSourceTemplate) {
        issues.push(issue("error", "dsl.workflow.subprocess.template_required", "Start subprocess requires a target templateId or a sourceTemplateId awaiting explicit resolution.", `${path}/subProcess/templateId`));
      } else if (!hasTargetTemplate && hasSourceTemplate) {
        issues.push(issue(
          "warning",
          "dsl.workflow.subprocess.template_resolution_required",
          "Source subprocess templates require an explicitly validated target override before persistence.",
          `${path}/subProcess/sourceTemplateId`
        ));
      }
      if (String(node.subProcess.flowType) === "1") {
        issues.push(...standaloneSubProcessIssues(node.subProcess, `${path}/subProcess`));
        continue;
      }
      issues.push(...subProcessRecoveryIssues(node.subProcess, `${path}/subProcess`));
      const recover = nodeMap.get(recoverId);
      if (!recover || recover.type !== "recoverSubProcess" || recover.subProcess?.startNodeId !== node.id) {
        issues.push(issue("error", "dsl.workflow.subprocess.recover_pair_invalid", "Start subprocess must reference a reciprocal recoverSubProcess node.", `${path}/subProcess/recoverNodeId`));
      }
      if (mode === "execute") {
        const bridge = edges.filter((edge) => edge?.source === node.id && edge?.target === recoverId);
        if (bridge.length !== 1) {
          issues.push(issue("error", "dsl.workflow.subprocess.bridge_required", "Executable subprocess pair requires one start-to-recover bridge edge.", "/workflow/edges"));
        }
      }
    } else {
      issues.push(...subProcessRecoveryIssues(node.subProcess, `${path}/subProcess`));
      const start = nodeMap.get(node.subProcess.startNodeId);
      if (!start || start.type !== "startSubProcess" || start.subProcess?.recoverNodeId !== node.id) {
        issues.push(issue("error", "dsl.workflow.subprocess.start_pair_invalid", "Recover subprocess must reference a reciprocal startSubProcess node.", `${path}/subProcess/startNodeId`));
      }
    }
  }
  return issues;
}

function standaloneSubProcessIssues(subProcess, path) {
  const issues = [];
  if (
    subProcess.recoverNodeId !== undefined ||
    subProcess.variableScope !== undefined ||
    subProcess.recoverRule !== undefined ||
    (Array.isArray(subProcess.recoverParamConfig) && subProcess.recoverParamConfig.length > 0)
  ) {
    issues.push(issue(
      "error",
      "dsl.workflow.subprocess.continue_recovery_forbidden",
      "Continue-flow subprocesses cannot declare recovery or child-to-parent mappings.",
      path
    ));
  }
  const startIdentity = subProcess.startIdentity;
  const members = startIdentity?.members;
  if (
    !isRecord(startIdentity) ||
    startIdentity.mode !== "explicit" ||
    !Array.isArray(members) ||
    members.length === 0
  ) {
    issues.push(issue(
      "error",
      "dsl.workflow.subprocess.start_identity_required",
      "Continue-flow subprocesses require an explicit source-backed or resolved start identity.",
      `${path}/startIdentity`
    ));
    return issues;
  }
  members.forEach((member, index) => {
    const sourceBacked = nonEmptyString(member?.sourceId) && Number.isInteger(Number(member?.sourceOrgType));
    const targetBacked = nonEmptyString(member?.id) && Number.isInteger(Number(member?.targetOrgType));
    if (!isRecord(member) || !nonEmptyString(member.name) || (!sourceBacked && !targetBacked)) {
      issues.push(issue(
        "error",
        "dsl.workflow.subprocess.start_identity_member_invalid",
        "Subprocess start-identity members require a name and either source or resolved target identity.",
        `${path}/startIdentity/members/${index}`
      ));
    }
  });
  return issues;
}

function subProcessRecoveryIssues(subProcess, path) {
  const issues = [];
  const expression = subProcess.recoverRule?.expression;
  const supportedRecovery = Number(subProcess.variableScope) === 2 &&
    Number(subProcess.recoverRule?.type) === 1 &&
    isRecord(expression) &&
    !String(expression.text || "").trim() &&
    !String(expression.value || "").trim();
  if (!supportedRecovery) {
    issues.push(issue(
      "error",
      "dsl.workflow.subprocess.recovery_unsupported",
      "Subprocess recovery must use the fixture-backed wait-for-all recovery scope and empty completion rule.",
      path
    ));
  }
  if (subProcess.flowType !== undefined && String(subProcess.flowType) !== "2") {
    issues.push(issue(
      "error",
      "dsl.workflow.subprocess.flow_type_invalid",
      "Wait-for-all subprocess recovery must project to native flowType 2.",
      `${path}/flowType`
    ));
  }
  return issues;
}

function issue(level, code, message, path) {
  return { level, code, message, path };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
