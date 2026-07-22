import { integrityError } from "./integrity.js";

export const REVIEW_SCENARIOS = Object.freeze([
  "accept",
  "warning",
  "audited-row-marker-orphan-noop",
  "fail-if-called"
]);
export const NEWOA_SCENARIOS = Object.freeze([
  "persist",
  "lose-layout-on-readback",
  "lose-required-on-readback",
  "fail-at-update"
]);

const SUCCESS_OPERATIONS = Object.freeze([
  "login",
  "init",
  "generate-table-name",
  "load-parent-category",
  "add",
  "get-before-update",
  "update",
  "get-readback"
]);

const WORKFLOW_SUCCESS_OPERATIONS = Object.freeze([
  SUCCESS_OPERATIONS[0],
  "search-org",
  "get-element-info",
  ...SUCCESS_OPERATIONS.slice(1, -1),
  "save-workflow-draft",
  "get-workflow-detail",
  "get-readback"
]);

const DRAFT_WORKFLOW_SUCCESS_OPERATIONS = Object.freeze([
  SUCCESS_OPERATIONS[0],
  ...SUCCESS_OPERATIONS.slice(1, -1),
  "save-workflow-draft",
  "get-workflow-detail",
  "get-readback"
]);

const CONDITIONAL_WORKFLOW_SUCCESS_OPERATIONS = Object.freeze([
  "login",
  "get-xform-desktop-digest",
  "get-xform-desktop-module-sha256",
  "get-xform-desktop-module-sha256",
  "search-org",
  "get-element-info",
  "search-org",
  "search-org",
  "get-element-info",
  ...SUCCESS_OPERATIONS.slice(1, -1),
  "save-workflow-draft",
  "get-workflow-detail",
  "get-readback"
]);

const CONDITIONAL_PARALLEL_SUCCESS_OPERATIONS = Object.freeze([
  "login",
  "get-element-info",
  "get-element-info",
  "get-element-info",
  ...SUCCESS_OPERATIONS.slice(1, -1),
  "save-workflow-draft",
  "get-workflow-detail",
  "get-readback"
]);

export const ROUTE_CASE_MANIFEST = deepFreeze({
  version: 1,
  cases: [
    {
      id: "form-only-success",
      source: {
        kind: "form-only",
        relativePath: "form-only/route-form-only_SysFormTemplate.xml",
        templateName: "原流程模板"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "option-normalization-success",
      source: {
        kind: "form-only",
        relativePath: "option-normalization/route-option-normalization_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "semantic-props-success",
      source: {
        kind: "paired",
        relativePath: "semantic-props"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: DRAFT_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "calculation-migration-success",
      source: {
        kind: "form-only",
        relativePath: "calculation-migration/route-calculation-migration_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "calculation-script-recipes-success",
      source: {
        kind: "form-only",
        relativePath: "calculation-script-recipes/route-calculation-script-recipes_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "finance-detail-generation-success",
      source: {
        kind: "form-only",
        relativePath: "finance-detail-generation/route-finance-detail-generation_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "multi-batch-review-success",
      source: {
        kind: "form-only",
        relativePath: "multi-batch/route-multi-batch_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "custom-base-url-success",
      source: {
        kind: "form-only",
        relativePath: "form-only/route-form-only_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      baseUrl: " http://LOCALHOST:8080/ ",
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "paired-success",
      source: {
        kind: "paired",
        relativePath: "paired"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "conditional-parallel-success",
      source: {
        kind: "paired",
        relativePath: "conditional-parallel"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: CONDITIONAL_PARALLEL_SUCCESS_OPERATIONS
      }
    },
    {
      id: "manual-branch-success",
      source: {
        kind: "paired",
        relativePath: "manual-branch"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: DRAFT_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "shanghai-electric-dev-fallback-success",
      source: {
        kind: "paired",
        relativePath: "conditional-detail"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      baseUrl: "http://oa-dev.shanghai-electric.com:8088",
      fallbackFdIds: {
        person: "route-configured-person-fallback",
        organization: "route-configured-organization-fallback"
      },
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: CONDITIONAL_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "kmreview-named-success",
      source: {
        kind: "paired",
        relativePath: "kmreview-named"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "warning-but-executable",
      source: {
        kind: "form-only",
        relativePath: "form-only/route-form-only_SysFormTemplate.xml"
      },
      reviewScenario: "warning",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "row-marker-orphan-noop-success",
      source: {
        kind: "form-only",
        relativePath: "row-marker-orphan/route-row-marker-orphan_SysFormTemplate.xml"
      },
      reviewScenario: "audited-row-marker-orphan-noop",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "conditional-detail-success",
      source: {
        kind: "paired",
        relativePath: "conditional-detail"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: CONDITIONAL_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "blocked-before-transport",
      source: {
        kind: "form-only",
        relativePath: "form-only/route-form-only_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: false,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "blocked",
        operations: []
      }
    },
    {
      id: "unmapped-formula-blocked-before-transport",
      source: {
        kind: "paired",
        relativePath: "unmapped-formula"
      },
      reviewScenario: "fail-if-called",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        terminalStage: "review",
        reviewStatus: "blocked",
        reviewStage: "agent-review.input",
        operations: []
      }
    },
    {
      id: "readback-loss",
      source: {
        kind: "paired",
        relativePath: "paired"
      },
      reviewScenario: "accept",
      newoaScenario: "lose-layout-on-readback",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "readback_failed",
        executionStage: "readback",
        operations: WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "required-readback-loss",
      source: {
        kind: "form-only",
        relativePath: "form-only/route-form-only_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "lose-required-on-readback",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "readback_failed",
        executionStage: "readback",
        operations: SUCCESS_OPERATIONS
      }
    }
  ]
});

export function validateRouteManifest(manifest) {
  assertPureData(manifest, "manifest");
  if (manifest?.version !== 1 || !Array.isArray(manifest?.cases) || manifest.cases.length === 0) {
    throw integrityError("route.manifest.invalid", "Route manifest must have version 1 and at least one case.");
  }

  const seen = new Set();
  for (const routeCase of manifest.cases) {
    if (!isPlainRecord(routeCase) || !nonEmptyString(routeCase.id) || seen.has(routeCase.id)) {
      throw integrityError("route.manifest.invalid", "Route case ids must be unique non-empty strings.");
    }
    seen.add(routeCase.id);
    if (!isPlainRecord(routeCase.source) || !["form-only", "paired"].includes(routeCase.source.kind)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has an invalid source kind.`);
    }
    if (!safeRelativePath(routeCase.source.relativePath)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has an unsafe fixture path.`);
    }
    if (routeCase.source.templateName !== undefined && !nonEmptyString(routeCase.source.templateName)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has an invalid source template name.`);
    }
    if (!REVIEW_SCENARIOS.includes(routeCase.reviewScenario)) {
      throw integrityError("route.scenario.review_unknown", `Unknown review scenario: ${routeCase.reviewScenario}`);
    }
    if (!NEWOA_SCENARIOS.includes(routeCase.newoaScenario)) {
      throw integrityError("route.scenario.newoa_unknown", `Unknown NewOA scenario: ${routeCase.newoaScenario}`);
    }
    if (typeof routeCase.confirmWrite !== "boolean" || !isPlainRecord(routeCase.expected)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has invalid execution data.`);
    }
    if (routeCase.baseUrl !== undefined && !nonEmptyString(routeCase.baseUrl)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has an invalid base URL.`);
    }
    if (routeCase.fallbackFdIds !== undefined && !validFallbackFdIds(routeCase.fallbackFdIds)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has invalid fallback fdIds.`);
    }
    const expected = routeCase.expected;
    const reviewTerminal = expected.terminalStage === "review";
    if (!nonEmptyString(expected.reviewStatus) ||
        !Array.isArray(expected.operations) ||
        expected.operations.some((operation) => !nonEmptyString(operation)) ||
        (reviewTerminal && (!nonEmptyString(expected.reviewStage) || expected.operations.length !== 0)) ||
        (!reviewTerminal && (!nonEmptyString(expected.dryRunStatus) || !nonEmptyString(expected.executionStatus))) ||
        (expected.terminalStage !== undefined && !reviewTerminal)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has invalid expected data.`);
    }
  }
  return manifest;
}

export function findRouteCase(caseId, manifest = ROUTE_CASE_MANIFEST) {
  validateRouteManifest(manifest);
  const routeCase = manifest.cases.find((candidate) => candidate.id === caseId);
  if (!routeCase) {
    throw integrityError("route.case.unknown", `Unknown Route case: ${caseId}`);
  }
  return routeCase;
}

function assertPureData(value, path) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPureData(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainRecord(value)) {
    throw integrityError("route.manifest.not_data", `Route manifest contains non-data at ${path}.`);
  }
  for (const [key, entry] of Object.entries(value)) {
    assertPureData(entry, `${path}.${key}`);
  }
}

function safeRelativePath(value) {
  return nonEmptyString(value) && !value.startsWith("/") && !value.split(/[\\/]+/).includes("..");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function isPlainRecord(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validFallbackFdIds(value) {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set(["person", "organization", "group", "post"]);
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([kind, fdId]) => allowed.has(kind) && nonEmptyString(fdId));
}
