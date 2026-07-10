import { integrityError } from "./integrity.js";

export const REVIEW_SCENARIOS = Object.freeze(["accept", "warning"]);
export const NEWOA_SCENARIOS = Object.freeze(["persist", "lose-layout-on-readback", "lose-required-on-readback", "fail-at-update"]);

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
  ...SUCCESS_OPERATIONS.slice(0, -1),
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
        relativePath: "form-only/route-form-only_SysFormTemplate.xml"
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
    if (!REVIEW_SCENARIOS.includes(routeCase.reviewScenario)) {
      throw integrityError("route.scenario.review_unknown", `Unknown review scenario: ${routeCase.reviewScenario}`);
    }
    if (!NEWOA_SCENARIOS.includes(routeCase.newoaScenario)) {
      throw integrityError("route.scenario.newoa_unknown", `Unknown NewOA scenario: ${routeCase.newoaScenario}`);
    }
    if (typeof routeCase.confirmWrite !== "boolean" || !isPlainRecord(routeCase.expected)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has invalid execution data.`);
    }
    if (!nonEmptyString(routeCase.expected.reviewStatus) ||
        !nonEmptyString(routeCase.expected.dryRunStatus) ||
        !nonEmptyString(routeCase.expected.executionStatus) ||
        !Array.isArray(routeCase.expected.operations) ||
        routeCase.expected.operations.some((operation) => !nonEmptyString(operation))) {
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
