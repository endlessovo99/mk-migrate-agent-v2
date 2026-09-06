import { NEWOA_SCENARIOS } from "./manifest.js";
import { integrityError } from "./integrity.js";
import { appendTranscriptEntry, sanitizedTranscript } from "./transcript.js";
import { SIT_PARTICIPANT_FALLBACKS } from "../../src/executor/participant-resolver.js";
import { SIT_CONDITION_ORG_FALLBACKS } from "../../src/executor/condition-org-resolver.js";
import { NATIVE_FORM_RULE_FORMULA_RUNTIME_CAPABILITY } from "../../src/executor/native-form-rule-runtime-capability.js";

const CREATED_TEMPLATE_ID = "route-created-template";
const CREATED_WORKFLOW_TEMPLATE_ID = "route-created-workflow-template";
const ROUTE_CONDITION_ORG = Object.freeze({
  fdId: "route-org-001",
  fdName: "Route Example Organization",
  fdOrgType: 2,
  fdNo: "ROUTE_ORG_001"
});
const ROUTE_GENERIC_ROLE = Object.freeze({
  fdId: "route-direct-manager-role",
  fdName: "<直线领导>",
  fdOrgType: 32
});
const ROUTE_STATIC_ADDRESS_DEFAULT = Object.freeze({
  fdId: "route-fixed-org",
  fdName: "Route Fixed Organization",
  fdOrgType: 2
});
const LEGACY_GENERIC_ROLE_ID = "legacy-direct-manager-role";
const SIT_CONDITION_ORG_FALLBACK_ID = SIT_CONDITION_ORG_FALLBACKS[0].fdId;
const SIT_FALLBACK_BY_ID = new Map([
  ...Object.values(SIT_PARTICIPANT_FALLBACKS).map((fallback) => [fallback.fdId, fallback]),
  [SIT_CONDITION_ORG_FALLBACK_ID, SIT_CONDITION_ORG_FALLBACKS[0]]
]);
const CONFIGURED_FALLBACK_SHAPES = Object.freeze({
  person: Object.freeze({ fdName: "Route Configured Person", fdOrgType: 8 }),
  organization: Object.freeze({ fdName: "Route Configured Organization", fdOrgType: 2 }),
  group: Object.freeze({ fdName: "Route Configured Group", fdOrgType: 16 }),
  post: Object.freeze({ fdName: "Route Configured Post", fdOrgType: 4 })
});

export class FakeNewoaAdapter {
  constructor(scenario, options = {}) {
    if (!NEWOA_SCENARIOS.includes(scenario)) {
      throw integrityError("route.scenario.newoa_unknown", `Unknown NewOA scenario: ${scenario}`);
    }
    this.scenario = scenario;
    this.entries = [];
    this.template = undefined;
    this.workflowDraft = undefined;
    this.updated = false;
    this.authorizationCandidates = authorizationCandidates(options.templateAuthorization);
    this.authorizationCandidateById = new Map(
      this.authorizationCandidates.map((candidate) => [candidate.fdId, candidate])
    );
    this.fallbackById = new Map(SIT_FALLBACK_BY_ID);
    for (const [kind, fdId] of Object.entries(options.fallbackFdIds || {})) {
      const shape = CONFIGURED_FALLBACK_SHAPES[kind];
      if (shape) this.fallbackById.set(fdId, { fdId, ...shape });
    }
  }

  async login() {
    this.record({ operation: "login" });
    return { ok: true };
  }

  async assertTransferRecordAuthentication() {}

  async getXFormDesktopDigest() {
    this.record({ operation: "get-xform-desktop-digest" });
    return {
      [NATIVE_FORM_RULE_FORMULA_RUNTIME_CAPABILITY.runtimeModule]: {
        hash: NATIVE_FORM_RULE_FORMULA_RUNTIME_CAPABILITY.runtimeHash
      },
      [NATIVE_FORM_RULE_FORMULA_RUNTIME_CAPABILITY.ideModule]: {
        hash: NATIVE_FORM_RULE_FORMULA_RUNTIME_CAPABILITY.ideHash
      }
    };
  }

  async getXFormDesktopModuleSha256({ modulePath }) {
    this.record({ operation: "get-xform-desktop-module-sha256", modulePath });
    if (modulePath === NATIVE_FORM_RULE_FORMULA_RUNTIME_CAPABILITY.runtimePath) {
      return NATIVE_FORM_RULE_FORMULA_RUNTIME_CAPABILITY.runtimeSha256;
    }
    if (modulePath === NATIVE_FORM_RULE_FORMULA_RUNTIME_CAPABILITY.idePath) {
      return NATIVE_FORM_RULE_FORMULA_RUNTIME_CAPABILITY.ideSha256;
    }
    return "unknown";
  }

  async searchOrg(key) {
    this.record({ operation: "search-org", key });
    const authorizationMatches = this.authorizationCandidates.filter((candidate) => (
      candidate.searchKeys.includes(key)
    ));
    if (authorizationMatches.length) {
      return authorizationMatches.map(({ searchKeys: _searchKeys, ...candidate }) => clone(candidate));
    }
    if (key === ROUTE_CONDITION_ORG.fdNo) {
      return [clone(ROUTE_CONDITION_ORG)];
    }
    if (key === ROUTE_GENERIC_ROLE.fdName) {
      return [clone(ROUTE_GENERIC_ROLE)];
    }
    return [];
  }

  async getElementInfo(targets) {
    this.record({ operation: "get-element-info", targets: clone(targets) });
    return targets.flatMap((fdId) => {
      const authorizationCandidate = this.authorizationCandidateById.get(fdId);
      if (authorizationCandidate) {
        const { searchKeys: _searchKeys, ...candidate } = authorizationCandidate;
        return [clone(candidate)];
      }
      if (fdId === LEGACY_GENERIC_ROLE_ID) return [];
      if (fdId === ROUTE_STATIC_ADDRESS_DEFAULT.fdId) {
        return [clone(ROUTE_STATIC_ADDRESS_DEFAULT)];
      }
      const fallback = this.fallbackById.get(fdId);
      if (fallback) {
        return [{
          fdId: fallback.fdId,
          fdName: fallback.fdName,
          fdOrgType: fallback.fdOrgType,
          ...(fallback.fdNo ? { fdNo: fallback.fdNo } : {})
        }];
      }
      return [{
        fdId,
        fdName: fdId,
        fdOrgType: 8
      }];
    });
  }

  async initTemplate() {
    this.record({ operation: "init" });
    return {
      fdId: "route-init-template",
      fdName: "Route Initial Template",
      fdCode: "route_base",
      fdStatus: 0,
      mechanisms: {
        "sys-xform": {
          fdId: "route-init-template",
          fdName: "Route Initial Template",
          fdTableName: "route_model_base",
          fdConfig: "{}"
        },
        lbpmTemplate: [{ fdTemplateForms: [] }]
      }
    };
  }

  async generateTableName() {
    this.record({ operation: "generate-table-name" });
    return "route_model_generated";
  }

  async loadParentCategory(categoryId) {
    this.record({ operation: "load-parent-category", categoryId });
    return { fdFormCategoryId: categoryId, fdName: "Route Category" };
  }

  async addTemplate(payload) {
    this.template = clone(payload);
    this.template.fdId = CREATED_TEMPLATE_ID;
    const lbpm = this.template.mechanisms?.lbpmTemplate?.[0];
    if (lbpm) lbpm.fdId = CREATED_WORKFLOW_TEMPLATE_ID;
    this.record({
      operation: "add",
      templateId: CREATED_TEMPLATE_ID,
      templateName: payload.fdName,
      draft: true
    });
    return { fdId: CREATED_TEMPLATE_ID, fdName: payload.fdName };
  }

  async getTemplate(templateId) {
    const operation = this.updated ? "get-readback" : "get-before-update";
    this.record({ operation, templateId });
    if (!this.template) {
      throw integrityError("route.fake.state", "Template was read before it was created.");
    }
    const template = clone(this.template);
    if (this.updated && this.scenario === "lose-layout-on-readback") {
      return loseLayoutCell(template);
    }
    if (this.updated && this.scenario === "lose-required-on-readback") {
      return loseRequiredField(template, "fd_subject");
    }
    return template;
  }

  async updateTemplate(payload) {
    this.record({ operation: "update", templateId: payload.fdId || CREATED_TEMPLATE_ID });
    if (this.scenario === "fail-at-update") {
      const error = new Error("Deterministic fake update failure.");
      error.stage = "update";
      throw error;
    }
    this.template = clone(payload);
    this.updated = true;
    return { fdId: payload.fdId || CREATED_TEMPLATE_ID };
  }

  async saveWorkflowDraft(payload) {
    this.record({
      operation: "save-workflow-draft",
      templateId: payload.fdId,
      draft: payload.isDraft === true,
      notifyDrafterOnEnd: payload.notifyDrafterOnEnd,
      notifyParticipantOnEnd: payload.notifyParticipantOnEnd
    });
    this.workflowDraft = clone(payload);
    return { fdId: CREATED_WORKFLOW_TEMPLATE_ID };
  }

  async getWorkflowTemplateDetail({ templateId, definitionId }) {
    this.record({
      operation: "get-workflow-detail",
      templateId,
      definitionId
    });
    return {
      ...clone(this.workflowDraft),
      fdId: CREATED_WORKFLOW_TEMPLATE_ID,
      isDraft: true,
      fdStatus: "draft"
    };
  }

  async addTransferRecord(payload) {
    this.record({
      operation: "add-transfer-record",
      recordId: payload.fdId,
      sourceTemplateId: payload.fdOriginalId,
      targetTemplateId: payload.fdTargetId,
      templateName: payload.fdName,
      createTime: payload.fdCreateTime
    });
    return { fdId: payload.fdId };
  }

  transcript() {
    return sanitizedTranscript(this.entries);
  }

  record(entry) {
    if (
      entry?.operation === "get-xform-desktop-digest" ||
      entry?.operation === "get-xform-desktop-module-sha256"
    ) {
      this.entries.push(clone(entry));
      return;
    }
    appendTranscriptEntry(this.entries, entry);
  }
}

function authorizationCandidates(authorization) {
  if (!authorization || typeof authorization !== "object") return [];
  const candidates = new Map();
  for (const collectionName of [
    "readers",
    "editors",
    "allReaders",
    "allEditors",
    "temporaryReaders",
    "temporaryEditors"
  ]) {
    for (const member of authorization[collectionName] || []) {
      if (!member?.sourceId || !member?.name || !member?.sourceOrgType) continue;
      const searchKeys = new Set([
        member.name,
        member.sourceLoginName,
        qualifiedLeafName(member.name, member.sourceOrgType)
      ].filter(Boolean));
      candidates.set(member.sourceId, {
        fdId: member.sourceId,
        fdName: member.name,
        fdOrgType: member.sourceOrgType,
        ...(member.sourceLoginName ? {
          fdLoginName: member.sourceLoginName,
          fdNo: member.sourceLoginName
        } : {}),
        ...(member.sourceParentName ? { fdParentName: member.sourceParentName } : {}),
        searchKeys: [...searchKeys]
      });
    }
  }
  return [...candidates.values()];
}

function qualifiedLeafName(name, orgType) {
  if (![4, 32, 128].includes(Number(orgType))) return name;
  const index = String(name).lastIndexOf("_");
  return index >= 0 ? String(name).slice(index + 1).trim() : name;
}

function clone(value) {
  return structuredClone(value);
}

function loseLayoutCell(template) {
  const xform = template?.mechanisms?.["sys-xform"];
  const config = parseJsonObject(xform?.fdConfig);
  const view = parseJsonObject(config.viewModel?.[0]?.fdConfig);
  const grid = findNode(view, (node) => node.type === "@elem/layout-grid" && node.children?.length);
  if (!grid) {
    throw integrityError("route.scenario.not_applied", "The readback-loss scenario could not find a persisted layout cell.");
  }
  grid.children = grid.children.slice(0, -1);
  config.viewModel[0].fdConfig = JSON.stringify(view);
  xform.fdConfig = JSON.stringify(config);
  return template;
}

function loseRequiredField(template, fieldId) {
  const xform = template?.mechanisms?.["sys-xform"];
  const config = parseJsonObject(xform?.fdConfig);
  const main = (config.dataModel || []).find((model) => model?.fdType === "main");
  const field = (main?.fdFields || []).find((candidate) => candidate?.fdName === fieldId);
  const attribute = parseJsonObject(field?.fdAttribute);
  if (attribute.config?.controlProps?.required !== true) {
    throw integrityError("route.scenario.not_applied", "The required-loss scenario could not find a persisted required field.");
  }
  delete attribute.config.controlProps.required;
  field.fdAttribute = JSON.stringify(attribute);
  xform.fdConfig = JSON.stringify(config);
  return template;
}

function findNode(value, predicate) {
  if (!value || typeof value !== "object") return undefined;
  if (predicate(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNode(entry, predicate);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      const found = findNode(entry, predicate);
      if (found) return found;
    }
  }
  return undefined;
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
