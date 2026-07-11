#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runAgentReview } from "../src/agent-review/index.js";
import { selectNewoaBaseUrl } from "../src/cli/base-url.js";
import { executeDsl } from "../src/executor/execute.js";
import { cleanSourceFile, draftSourceDraft } from "../src/translator/index.js";

const DEFAULT_FIXTURES = [
  {
    id: "19bb55286bd93a6081a33e44c3791374",
    mode: "layered-translation",
    description: "real Agent should map detail-row behavior, omit native-covered row rules, and keep complex onLoad blocked"
  },
  {
    id: "16add0fe7fea9a568c7f4514527a7829",
    mode: "partial-translation",
    description: "real Agent should improve translated or native-covered JSP action coverage"
  },
  {
    id: "160de1c3bc9590b8b2ce02a4b4a95845",
    mode: "diagnostic",
    description: "real Agent diagnostics or partial patches for complex JSP"
  }
];

const args = parseArgs(process.argv.slice(2));
const outputDir = args["out-dir"] || ".tmp/agent-review-live";
const targetCategoryId = args["target-category-id"] || process.env.NEWOA_TARGET_CATEGORY_ID || "";
const newoaBaseUrl = selectNewoaBaseUrl(args["base-url"], process.env.NEWOA_BASE_URL);
const executeFixtureId = args["execute-fixture"] || DEFAULT_FIXTURES.find((fixture) => fixture.mode === "execute")?.id || "";
const partialActionLimit = positiveInteger(args["partial-action-limit"] || process.env.AGENT_REVIEW_PARTIAL_ACTION_LIMIT, 8);
const reviewRetryCount = positiveInteger(args["review-retries"] || process.env.AGENT_REVIEW_LIVE_RETRIES, 2);
const requestedFixtures = stringList(args.fixture || args.fixtures);
const fixtures = requestedFixtures.length
  ? DEFAULT_FIXTURES.filter((fixture) => requestedFixtures.includes(fixture.id))
  : DEFAULT_FIXTURES;
const summaries = [];

if (requestedFixtures.length && fixtures.length !== requestedFixtures.length) {
  const known = new Set(DEFAULT_FIXTURES.map((fixture) => fixture.id));
  const unknown = requestedFixtures.filter((id) => !known.has(id));
  throw new Error(`Unknown fixture id(s): ${unknown.join(", ")}`);
}

mkdirSync(outputDir, { recursive: true });

for (const fixture of fixtures) {
  const sourcePath = `tests/fixtures/source/${fixture.id}`;
  const fixtureDir = join(outputDir, fixture.id);
  mkdirSync(fixtureDir, { recursive: true });
  clearFixtureOutputs(fixtureDir);

  const sourceDraft = cleanSourceFile(sourcePath);
  const dslDraft = draftSourceDraft(sourceDraft);
  writeJson(join(fixtureDir, "source-draft.json"), sourceDraft);
  writeJson(join(fixtureDir, "dsl-draft.json"), dslDraft);

  const reviewInput = fixture.mode === "partial-translation"
    ? sliceForPartialAgentReview(sourceDraft, dslDraft, { maxActions: partialActionLimit })
    : { sourceDraft, dslDraft, slice: undefined };
  const before = summarizeScripts(reviewInput.dslDraft.scripts);
  if (reviewInput.slice) {
    writeJson(join(fixtureDir, "review-source-draft.json"), reviewInput.sourceDraft);
    writeJson(join(fixtureDir, "review-dsl-draft.json"), reviewInput.dslDraft);
    writeJson(join(fixtureDir, "review-slice.json"), reviewInput.slice);
  }

  const result = await runAgentReviewWithRetry(reviewInput.sourceDraft, reviewInput.dslDraft, { retries: reviewRetryCount });
  writeJson(join(fixtureDir, "agent-review.report.json"), result.report);

  const reviewedDsl = result.ok ? result.dsl : result.dslDraft;
  if (reviewedDsl) {
    writeJson(join(fixtureDir, result.ok ? "migration.dsl.json" : "reviewed-dsl-draft.json"), reviewedDsl);
  }

  const after = summarizeScripts(reviewedDsl?.scripts);
  let executeReport;
  if (fixture.id === executeFixtureId && result.ok && targetCategoryId) {
    executeReport = await executeDsl(result.dsl, {
      confirmWrite: true,
      targetCategoryId,
      baseUrl: newoaBaseUrl,
      credentials: {
        username: process.env.NEWOA_USERNAME,
        encryptedPassword: process.env.NEWOA_ENCRYPTED_PASSWORD
      }
    });
    writeJson(join(fixtureDir, "execute.report.json"), executeReport);
  }

  const summary = {
    fixtureId: fixture.id,
    description: fixture.description,
    mode: fixture.mode,
    ok: result.ok,
    stage: result.report?.stage,
    provider: result.report?.provider,
    baseUrl: result.report?.baseUrl,
    model: result.report?.model,
    acceptedPatchCount: result.report?.acceptedPatchCount || 0,
    diagnosticCount: result.report?.diagnosticCount || 0,
    reviewAttempts: result.reviewAttempts,
    reviewSlice: reviewInput.slice,
    before,
    after,
    execute: executeReport ? {
      ok: executeReport.ok,
      status: executeReport.status,
      templateId: executeReport.templateId,
      diagnostics: executeReport.diagnostics
    } : undefined,
    criteria: evaluateCriteria(fixture, { result, before, after, executeReport, targetCategoryId })
  };
  summaries.push(summary);
  writeJson(join(fixtureDir, "summary.json"), summary);
}

const overall = {
  ok: summaries.every((summary) => summary.criteria.ok),
  status: summaries.every((summary) => summary.criteria.ok) ? "passed" : "failed",
  outputDir,
  targetCategoryId: targetCategoryId || undefined,
  summaries
};
writeJson(join(outputDir, "summary.json"), overall);
printJson(overall);
process.exit(overall.ok ? 0 : 1);

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function clearFixtureOutputs(fixtureDir) {
  for (const fileName of [
    "source-draft.json",
    "dsl-draft.json",
    "review-source-draft.json",
    "review-dsl-draft.json",
    "review-slice.json",
    "agent-review.report.json",
    "migration.dsl.json",
    "reviewed-dsl-draft.json",
    "execute.report.json",
    "summary.json"
  ]) {
    rmSync(join(fixtureDir, fileName), { force: true });
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function summarizeScripts(scripts = {}) {
  const actions = Array.isArray(scripts?.actions) ? scripts.actions : [];
  const byStatus = {};
  const byCoverage = {};
  for (const action of actions) {
    increment(byStatus, action.translationStatus || "unknown");
    increment(byCoverage, action.coverage?.status || "missing");
  }
  return {
    actionCount: actions.length,
    byStatus,
    byCoverage,
    mappedTranslated: actions.filter((action) =>
      action.translationStatus === "mapped" &&
      action.coverage?.status === "translated"
    ).length,
    resolvedCoverage: actions.filter((action) =>
      (action.translationStatus === "mapped" && action.coverage?.status === "translated") ||
      (action.translationStatus === "omitted" && action.coverage?.status === "covered")
    ).length,
    needsReview: byStatus.needs_review || 0
  };
}

function evaluateCriteria(fixture, context) {
  const { result, before, after, executeReport, targetCategoryId } = context;
  if (fixture.mode === "execute") {
    if (!result.ok) {
      return { ok: false, reason: "agent-review did not produce trusted DSL" };
    }
    if (!targetCategoryId) {
      return { ok: false, reason: "target category fdId was not provided for NewOA write" };
    }
    if (!executeReport?.ok) {
      return { ok: false, reason: "NewOA execute did not complete successfully" };
    }
    return { ok: true, reason: "trusted DSL was written to NewOA SIT" };
  }

  if (fixture.mode === "partial-translation") {
    const resolvedImproved = (after?.resolvedCoverage || 0) > (before?.resolvedCoverage || 0);
    const partialImproved = (result.report?.acceptedPatchCount || 0) > 0 &&
      ((after?.byCoverage?.partial || 0) > (before?.byCoverage?.partial || 0) ||
        (after?.byCoverage?.uncovered || 0) < (before?.byCoverage?.uncovered || 0));
    const improved = resolvedImproved || partialImproved;
    return improved
      ? { ok: true, reason: resolvedImproved ? "real Agent increased translated or native-covered script actions" : "real Agent produced partial JSP coverage progress" }
      : { ok: false, reason: "real Agent did not improve JSP script coverage" };
  }

  if (fixture.mode === "layered-translation") {
    if (["agent-review.network", "agent-review.env", "agent-review.input"].includes(result.report?.stage)) {
      return { ok: false, reason: `real Agent failed before usable review output at ${result.report?.stage}` };
    }
    const reviewedDsl = result.ok ? result.dsl : result.dslDraft;
    const actions = Array.isArray(reviewedDsl?.scripts?.actions) ? reviewedDsl.scripts.actions : [];
    const detailAction = actions[0];
    const nativeContentAction = actions[1];
    const nativeBudgetAction = actions[2];
    const onLoadAction = actions[3];
    const detailMapped = detailAction?.translationStatus === "mapped" &&
      detailAction?.coverage?.status === "translated";
    const nativeClosed = [nativeContentAction, nativeBudgetAction].every((action) =>
      action?.translationStatus === "omitted" &&
      action?.coverage?.status === "covered" &&
      Array.isArray(action.coverage.nativeRules) &&
      action.coverage.nativeRules.length > 0 &&
      Array.isArray(action.coverage.residuals) &&
      action.coverage.residuals.length === 0 &&
      action.function === ""
    );
    const onLoadStillBlocked = onLoadAction?.event === "onLoad" &&
      onLoadAction?.translationStatus === "needs_review" &&
      onLoadAction?.coverage?.status === "uncovered";
    if (detailMapped && nativeClosed && onLoadStillBlocked) {
      return { ok: true, reason: "real Agent mapped action 0, closed actions 1/2 as native-covered, and kept complex onLoad blocked" };
    }
    return {
      ok: false,
      reason: "real Agent did not preserve the expected layered JSP translation outcome",
      details: {
        detailMapped,
        nativeClosed,
        onLoadStillBlocked,
        statuses: actions.map((action, index) => ({
          index,
          event: action.event,
          translationStatus: action.translationStatus,
          coverageStatus: action.coverage?.status
        }))
      }
    };
  }

  if (fixture.mode === "diagnostic") {
    if (["agent-review.network", "agent-review.env", "agent-review.input"].includes(result.report?.stage)) {
      return { ok: false, reason: `real Agent diagnostic layer failed before usable review output at ${result.report?.stage}` };
    }
    const hasUsefulOutput = (result.report?.acceptedPatchCount || 0) > 0 ||
      (result.report?.diagnosticCount || 0) > 0 ||
      (result.report?.diagnostics || []).length > 0;
    return hasUsefulOutput
      ? { ok: true, reason: "real Agent produced diagnostics or partial review output" }
      : { ok: false, reason: "real Agent produced no diagnostics or patch output" };
  }

  return { ok: false, reason: `unknown fixture mode ${fixture.mode}` };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

async function runAgentReviewWithRetry(sourceDraft, dslDraft, options = {}) {
  const attempts = [];
  const maxAttempts = (options.retries || 0) + 1;
  let lastResult;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runAgentReview(sourceDraft, dslDraft);
    lastResult = result;
    attempts.push({
      attempt,
      ok: result.ok,
      stage: result.report?.stage,
      diagnosticCount: result.report?.diagnosticCount || 0,
      acceptedPatchCount: result.report?.acceptedPatchCount || 0
    });
    if (result.report?.stage !== "agent-review.network") {
      return { ...result, reviewAttempts: attempts };
    }
  }
  return { ...lastResult, reviewAttempts: attempts };
}

function sliceForPartialAgentReview(sourceDraft, dslDraft, options = {}) {
  const actions = Array.isArray(dslDraft?.scripts?.actions) ? dslDraft.scripts.actions : [];
  const nativeRuleRefs = nativeCoveredSourceRefs(dslDraft.formRules);
  const selectedActions = actions
    .map((action, index) => ({ action, index, rank: partialActionRank(action, nativeRuleRefs) }))
    .filter(({ action }) => action.translationStatus === "needs_review")
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, options.maxActions || 8)
    .map(({ action }) => action);
  const fallbackActions = selectedActions.length ? selectedActions : actions.slice(0, options.maxActions || 8);
  const sourceRefs = new Set(fallbackActions.flatMap((action) => action.sourceRefs || []).filter(Boolean));
  const fragmentIds = new Set();

  const slicedSource = clone(sourceDraft);
  const slicedDsl = clone(dslDraft);
  slicedSource.workflow = undefined;
  slicedDsl.workflow = undefined;
  slicedDsl.scripts = {
    ...(slicedDsl.scripts || {}),
    actions: clone(fallbackActions)
  };
  if (slicedDsl.formRules?.linkage) {
    slicedDsl.formRules = {
      ...slicedDsl.formRules,
      linkage: slicedDsl.formRules.linkage.filter((rule) => sourceRefs.has(rule?.meta?.sourceJsp))
    };
  }

  if (slicedSource.scripts) {
    const sources = Array.isArray(sourceDraft.scripts?.sources) ? sourceDraft.scripts.sources : [];
    const selectedSources = sources.filter((source) => {
      const selected = sourceRefs.has(source.sourceRef) || sourceRefs.has(source.id);
      if (selected && source.fragmentId) fragmentIds.add(source.fragmentId);
      return selected;
    });
    slicedSource.scripts = {
      ...slicedSource.scripts,
      displayJsp: undefined,
      sources: clone(selectedSources),
      fragments: (sourceDraft.scripts.fragments || []).filter((fragment) =>
        sourceRefs.has(fragment.sourceRef) || fragmentIds.has(fragment.id)
      )
    };
  }

  return {
    sourceDraft: slicedSource,
    dslDraft: slicedDsl,
    slice: {
      kind: "script-only-partial",
      sourceFixtureActionCount: actions.length,
      selectedActionCount: fallbackActions.length,
      sourceRefCount: sourceRefs.size,
      nativeRuleMatchedActionCount: fallbackActions.filter((action) =>
        (action.sourceRefs || []).some((ref) => nativeRuleRefs.has(ref))
      ).length,
      workflowOmitted: true,
      maxActions: options.maxActions || 8
    }
  };
}

function nativeCoveredSourceRefs(formRules = {}) {
  const refs = new Set();
  for (const rule of Array.isArray(formRules?.linkage) ? formRules.linkage : []) {
    if (rule?.translationStatus !== "executable") continue;
    if (rule?.meta?.sourceJsp) refs.add(rule.meta.sourceJsp);
  }
  return refs;
}

function partialActionRank(action, nativeRuleRefs) {
  const hasNativeRule = (action.sourceRefs || []).some((ref) => nativeRuleRefs.has(ref));
  const statusRank = hasNativeRule ? 0 : 10;
  const residualRank = Array.isArray(action.coverage?.residuals) ? Math.min(action.coverage.residuals.length, 4) : 4;
  const scopeRank = action.scope === "control" ? 0 : 1;
  return statusRank + residualRank + scopeRank / 10;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringList(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
