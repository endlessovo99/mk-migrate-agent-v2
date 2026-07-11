import { runAgentReview } from "../../src/agent-review/index.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { NEWOA_SIT_BASE_URL } from "../../src/executor/newoa-client.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { resolveRouteFixture } from "./fixture.js";
import { integrityError } from "./integrity.js";
import { findRouteCase } from "./manifest.js";
import { withNetworkGuard } from "./network-guard.js";
import { assertNoSecretLeak } from "./transcript.js";

const FIXED_NOW = "2026-07-10T00:00:00.000Z";
const TEST_CREDENTIALS = Object.freeze({
  username: "route-test-user",
  encryptedPassword: "route-test-encrypted-password"
});

export async function runRouteCase(caseId) {
  const routeCase = findRouteCase(caseId);
  const sourcePath = resolveRouteFixture(routeCase.source);

  return withNetworkGuard(async () => {
    const sourceDraft = cleanSourceFile(sourcePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const reviewResult = await runAgentReview(sourceDraft, dslDraft, {
      provider: createFakeReviewProvider(routeCase.reviewScenario),
      reviewedAt: FIXED_NOW
    });
    if (!reviewResult.ok) {
      throw unexpected("review", routeCase, reviewResult.report?.status, reviewResult.report?.stage);
    }

    const dryRun = buildDryRunPlan(reviewResult.dsl);
    if (!dryRun.ok) {
      throw unexpected("dry-run", routeCase, dryRun.status);
    }

    const adapter = new FakeNewoaAdapter(routeCase.newoaScenario);
    const execution = await executeDsl(reviewResult.dsl, {
      client: adapter,
      credentials: TEST_CREDENTIALS,
      confirmWrite: routeCase.confirmWrite,
      targetCategoryId: "route-category-id",
      baseUrl: routeCase.baseUrl ?? NEWOA_SIT_BASE_URL,
      now: new Date(FIXED_NOW)
    });
    const transcript = adapter.transcript();
    assertExpected(routeCase, reviewResult.report, dryRun, execution, transcript);

    const result = {
      caseId: routeCase.id,
      review: reviewResult.report,
      dsl: reviewResult.dsl,
      dryRun,
      execution,
      transcript
    };
    assertNoSecretLeak(result, Object.values(TEST_CREDENTIALS));
    return result;
  });
}

function assertExpected(routeCase, review, dryRun, execution, transcript) {
  const actualOperations = transcript.map((entry) => entry.operation);
  if (review.status !== routeCase.expected.reviewStatus) {
    throw unexpected("review", routeCase, review.status, review.stage);
  }
  if (dryRun.status !== routeCase.expected.dryRunStatus) {
    throw unexpected("dry-run", routeCase, dryRun.status);
  }
  if (execution.status !== routeCase.expected.executionStatus) {
    throw unexpected("execution", routeCase, execution.status, execution.stage);
  }
  if (routeCase.expected.executionStage !== undefined && execution.stage !== routeCase.expected.executionStage) {
    throw unexpected("execution", routeCase, execution.status, execution.stage);
  }
  if (JSON.stringify(actualOperations) !== JSON.stringify(routeCase.expected.operations)) {
    throw integrityError("route.transcript.unexpected", `Route case ${routeCase.id} recorded unexpected adapter operations.`, {
      expected: routeCase.expected.operations,
      actual: actualOperations
    });
  }
}

function unexpected(stage, routeCase, status, actualStage) {
  return integrityError("route.stage.unexpected", `Route case ${routeCase.id} reached an unexpected ${stage} outcome.`, {
    status,
    stage: actualStage
  });
}
