import { REVIEW_SCENARIOS } from "./manifest.js";
import { integrityError } from "./integrity.js";

export function createFakeReviewProvider(scenario) {
  if (!REVIEW_SCENARIOS.includes(scenario)) {
    throw integrityError("route.scenario.review_unknown", `Unknown review scenario: ${scenario}`);
  }

  const response = scenario === "warning"
    ? {
        summary: "Accepted with one deterministic manual-review warning.",
        patches: [],
        diagnostics: [{
          level: "warning",
          code: "route.review.needs_manual",
          path: "/review",
          message: "The deterministic Route scenario requires manual acknowledgement."
        }]
      }
    : {
        summary: "Accepted by the deterministic offline Route reviewer.",
        patches: [],
        diagnostics: []
      };

  return {
    metadata() {
      return {
        provider: "route-validation",
        baseUrl: "offline://route-review",
        model: "deterministic-review"
      };
    },
    async review() {
      return {
        ok: true,
        status: "received",
        stage: "agent-review.provider",
        provider: "route-validation",
        baseUrl: "offline://route-review",
        model: "deterministic-review",
        promptVersion: "route-review-v1",
        rawText: JSON.stringify(response)
      };
    }
  };
}
