import { NEWOA_SCENARIOS } from "./manifest.js";
import { integrityError } from "./integrity.js";
import { appendTranscriptEntry, sanitizedTranscript } from "./transcript.js";

const CREATED_TEMPLATE_ID = "route-created-template";

export class FakeNewoaAdapter {
  constructor(scenario) {
    if (!NEWOA_SCENARIOS.includes(scenario)) {
      throw integrityError("route.scenario.newoa_unknown", `Unknown NewOA scenario: ${scenario}`);
    }
    this.scenario = scenario;
    this.entries = [];
    this.template = undefined;
    this.updated = false;
  }

  async login() {
    this.record({ operation: "login" });
    return { ok: true };
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
    this.record({ operation: "add", templateId: CREATED_TEMPLATE_ID, draft: true });
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

  transcript() {
    return sanitizedTranscript(this.entries);
  }

  record(entry) {
    appendTranscriptEntry(this.entries, entry);
  }
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
