import { createHash } from "node:crypto";
import { stableStringify } from "./persistence/normalize.js";

const COLLECTIONS = ["readers", "editors", "allReaders", "allEditors", "temporaryReaders", "temporaryEditors"];
const SOURCE_KEYS = ["sourceId", "sourceOrgType", "sourceOrgClass", "sourceParentName", "sourceLoginName", "sourceRef"];
const PERSON_CLASS = "com.landray.kmss.sys.organization.model.SysOrgPerson";
const MISMATCH = "readback.workflow.template_authorization_mismatch";

// In invariant 29, allReaders/allEditors retain the resolved source collections.
// A single source member and a single expected ID therefore bind one identity;
// no ordering, name search, set subtraction or new fallback choice is needed.
export function restoreRetainedSingletonAuthorization(dsl, sourceDraft, report) {
  const auth = dsl?.template?.authorization;
  const stages = (report?.apiStages || []).filter(s => s?.name === "resolveWorkflowParticipants");
  const errors = (report?.diagnostics || []).filter(d => d?.level === "error");
  const mismatch = errors.find(d => d.code === MISMATCH);
  const sourceMembers = COLLECTIONS.flatMap(key => Array.isArray(auth?.[key]) ? auth[key].filter(hasSource) : []);
  const relevant = stages.some(s => s.fallbackCount > 0) || isClosureMismatch(mismatch?.details);
  if (!sourceMembers.length || !relevant) return { ok: true, dsl, audit: [] };

  const reject = reason => ({ ok: false, diagnostics: [{
    level: "error", code: "reconcile.prior_authorization_binding_unproven",
    message: "Retained execution evidence does not uniquely bind singleton template authorization.",
    path: "/priorExecutionReport", details: { reason }
  }] });
  if (report?.readback?.invariantVersion !== 29 || errors.length !== 1 || !isClosureMismatch(mismatch?.details)) {
    return reject("historical_authorization_shape");
  }
  const readbackErrors = (report.readback.diagnostics || []).filter(d => d?.level === "error");
  if (readbackErrors.length !== 1 || readbackErrors[0].code !== MISMATCH ||
      !same(readbackErrors[0].details?.expected, mismatch.details.expected) ||
      !same(readbackErrors[0].details?.actual, mismatch.details.actual) ||
      !same(report.readback.workflow?.templateAuthorization, mismatch.details.actual)) {
    return reject("historical_readback_inconsistent");
  }
  if (!singletonSourceAuthorization(auth) || !same(auth, sourceDraft?.template?.authorization)) {
    return reject("source_authorization_shape");
  }
  const reader = auth.allReaders[0];
  const editor = auth.allEditors[0];
  const expected = mismatch.details.expected;
  const readerId = expected.allReaders[0];
  const editorId = expected.allEditors[0];
  if (reader.sourceId === editor.sourceId || editor.sourceId !== editorId || sourceMembers.length !== 2) {
    return reject("source_identity_not_unique");
  }
  const directKeys = new Set();
  for (const node of dsl?.workflow?.nodes || []) {
    if (node?.participants?.mode === "configured_person_fallback") return reject("other_fallback_scope");
    for (const key of ["members", "alternativeMembers"]) {
      for (const member of node?.participants?.[key] || []) {
        if (hasSource(member) || !text(member?.id) || !Number.isInteger(member?.targetOrgType)) {
          return reject("other_unbound_identity");
        }
        directKeys.add(stableStringify([member.id, member.targetOrgType]));
      }
    }
  }
  if (stages.length !== 1 || stages[0].status !== "ok") return reject("resolution_stage");
  const stage = stages[0];
  const typed = stage.fallbackTargetsByOrgType;
  if (stage.fallbackCount !== 1 || stage.fallbackIdentityCount !== 1 || stage.resolvedCount !== 2 ||
      stage.identityCount !== directKeys.size + 2 || stage.fallbackTargetId !== readerId ||
      !same(stage.fallbackTargetIds, [readerId]) || !typed || !same(Object.keys(typed), ["8"]) ||
      typed["8"]?.sourceOrgType !== 8 || typed["8"]?.targetOrgType !== 8 ||
      typed["8"]?.targetFdId !== readerId || !text(typed["8"]?.targetName)) {
    return reject("fallback_evidence");
  }
  for (const key of ["overrides", "templateAuthorizationOverrides", "directOverrides", "directTargetFallbacks"]) {
    if (stage[key] !== undefined && (!Array.isArray(stage[key]) || stage[key].length)) return reject("mixed_resolution_evidence");
  }
  for (const key of ["overrideCount", "overrideIdentityCount", "templateAuthorizationOverrideCount", "templateAuthorizationOverrideIdentityCount", "directOverrideCount", "directOverrideIdentityCount", "directTargetFallbackCount", "directTargetFallbackIdentityCount"]) {
    if (stage[key] !== undefined && stage[key] !== 0) return reject("mixed_resolution_evidence");
  }
  const warnings = (report.diagnostics || []).filter(d => d?.code === "workflow.participant_sit_fallback_applied");
  const detail = warnings[0]?.details;
  if (warnings.length !== 1 || warnings[0].level !== "warning" || !object(detail) ||
      detail.referenceCount !== 1 || detail.identityCount !== 1 ||
      !same(detail.targetFdIds, [readerId]) || !same(detail.targetsByOrgType, typed) ||
      ["directTargetReferenceCount", "directTargetIdentityCount", "directTargetFallbacks"].some(key => Object.hasOwn(detail, key))) {
    return reject("fallback_warning_inconsistent");
  }
  const conditions = (report.apiStages || []).filter(s => s?.name === "resolveConditionOrgs");
  if (conditions.length !== 1 || conditions[0].status !== "ok" ||
      ["resolvedCount", "nameCount", "fdNoCount"].some(key => conditions[0][key] !== 0) ||
      !noConditionFallback(conditions[0]) ||
      (report.diagnostics || []).some(d => d?.code === "workflow.condition_org_sit_fallback_applied")) {
    return reject("other_resolution_scope");
  }

  const next = structuredClone(dsl);
  const reportDigest = createHash("sha256").update(stableStringify(report)).digest("hex");
  const audit = [["allReaders", readerId], ["allEditors", editorId]].map(([collection, id]) => {
    const member = next.template.authorization[collection][0];
    const sourceId = member.sourceId;
    const sourceRef = member.sourceRef;
    member.id = id;
    member.targetOrgType = 8;
    if (collection === "allReaders") member.name = typed["8"].targetName;
    for (const key of SOURCE_KEYS) delete member[key];
    return {
      kind: "retained_singleton_authorization", sourceId, sourceRef,
      paths: [`/template/authorization/${collection}/0`],
      target: { fdId: id, fdOrgType: 8 },
      priorInvariantVersion: 29, priorReportDigest: reportDigest,
      expectedCollection: collection, currentExactLookupRequired: true
    };
  });
  return { ok: true, dsl: next, audit };
}

function singletonSourceAuthorization(auth) {
  if (!auth || typeof auth.readerFlag !== "boolean" ||
      COLLECTIONS.some(key => !Array.isArray(auth[key]))) return false;
  if (["readers", "editors", "temporaryReaders", "temporaryEditors"].some(key => auth[key].length)) return false;
  return ["allReaders", "allEditors"].every(key => auth[key].length === 1 &&
    auth[key][0]?.type === "user_or_org" && !auth[key][0].id &&
    text(auth[key][0].sourceId) && text(auth[key][0].name) && text(auth[key][0].sourceRef) &&
    auth[key][0].sourceOrgType === 8 && auth[key][0].sourceOrgClass === PERSON_CLASS);
}

function isClosureMismatch(details) {
  const expected = details?.expected;
  const actual = details?.actual;
  if (!expected || !actual || !same(Object.keys(expected).sort(), [...COLLECTIONS].sort()) ||
      !same(Object.keys(actual).sort(), [...COLLECTIONS].sort()) ||
      COLLECTIONS.some(key => !Array.isArray(expected[key]) || !Array.isArray(actual[key]))) return false;
  if (["allReaders", "allEditors", "readers", "editors"].some(key => expected[key].length !== 1 || !text(expected[key][0])) ||
      expected.temporaryReaders.length || expected.temporaryEditors.length ||
      !same(expected.readers, expected.allReaders) || !same(expected.editors, expected.allEditors) ||
      expected.allReaders[0] === expected.allEditors[0]) return false;
  return COLLECTIONS.every(key => key === "allReaders"
    ? same([...actual[key]].sort(), [expected.allReaders[0], expected.allEditors[0]].sort())
    : same(actual[key], expected[key]));
}

function hasSource(member) {
  return member && typeof member === "object" && SOURCE_KEYS.slice(0, -1).some(key => Object.hasOwn(member, key));
}
function noConditionFallback(stage) {
  return Object.entries(stage).filter(([key]) => key.startsWith("fallback")).every(([key, value]) => {
    if (["fallbackCount", "fallbackIdentityCount"].includes(key)) return value === 0;
    if (key === "fallbackTargetId") return value === "";
    if (["fallbackTargetIds", "fallbackNames", "fallbackFdNos", "fallbackOrgs"].includes(key)) return Array.isArray(value) && value.length === 0;
    if (key === "fallbackTargetsByOrgType") return object(value) && Object.keys(value).length === 0;
    return false;
  });
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function same(left, right) { return stableStringify(left) === stableStringify(right); }
function text(value) { return typeof value === "string" && value.trim() === value && value.length > 0; }
