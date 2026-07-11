import { REVIEW_SCENARIOS } from "./manifest.js";
import { integrityError } from "./integrity.js";

export function createFakeReviewProvider(scenario) {
  if (!REVIEW_SCENARIOS.includes(scenario)) {
    throw integrityError("route.scenario.review_unknown", `Unknown review scenario: ${scenario}`);
  }

  return {
    metadata() {
      return {
        provider: "route-validation",
        baseUrl: "offline://route-review",
        model: "deterministic-review"
      };
    },
    async review({ dslDraft }) {
      const response = {
        summary: scenario === "warning"
          ? "Accepted with one deterministic manual-review warning."
          : "Accepted by the deterministic offline Route reviewer.",
        patches: [
          ...staticPropertyClosurePatches(dslDraft),
          ...nativeFormRuleClosurePatches(dslDraft)
        ],
        diagnostics: scenario === "warning"
          ? [{
              level: "warning",
              code: "route.review.needs_manual",
              path: "/review",
              message: "The deterministic Route scenario requires manual acknowledgement."
            }]
          : []
      };
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

function nativeFormRuleClosurePatches(dslDraft) {
  return (dslDraft?.scripts?.actions || []).flatMap((action, actionIndex) => {
    const coverage = action.coverage;
    if (
      coverage?.status !== "covered" ||
      !Array.isArray(coverage.nativeRules) ||
      coverage.nativeRules.length === 0 ||
      !Array.isArray(coverage.residuals) ||
      coverage.residuals.length > 0
    ) {
      return [];
    }

    const common = {
      op: "replace",
      sourceRefs: action.sourceRefs || [],
      evidence: ["Executable native form rules fully cover this tracked Route action."],
      confidence: 0.99,
      rationale: "Close deterministic native form-rule coverage without retaining duplicate script behavior."
    };
    return [
      { ...common, path: `/scripts/actions/${actionIndex}/function`, value: "" },
      { ...common, path: `/scripts/actions/${actionIndex}/translationStatus`, value: "omitted" },
      {
        ...common,
        path: `/scripts/actions/${actionIndex}/functionMappings`,
        value: [{
          source: "legacy JSP row visibility/required behavior",
          target: "native formRules.linkage",
          basis: "native-form-rule",
          reviewRequired: false
        }]
      },
      { ...common, path: `/scripts/actions/${actionIndex}/coverage`, value: coverage }
    ];
  });
}

function staticPropertyClosurePatches(dslDraft) {
  return (dslDraft?.scripts?.actions || []).flatMap((action, actionIndex) => {
    const staticProps = action.coverage?.staticProps;
    if (
      action.coverage?.status !== "covered" ||
      !Array.isArray(staticProps) ||
      staticProps.length === 0 ||
      action.coverage?.residuals?.length
    ) {
      return [];
    }

    const sourceRefs = action.sourceRefs || [];
    const common = {
      op: "replace",
      sourceRefs,
      evidence: ["The tracked Route fixture only repeats a required property already present in the DSL field."],
      confidence: 0.99,
      rationale: "Close deterministic static-property coverage without creating a form rule or executable script."
    };
    return [
      { ...common, path: `/scripts/actions/${actionIndex}/function`, value: "" },
      { ...common, path: `/scripts/actions/${actionIndex}/translationStatus`, value: "omitted" },
      {
        ...common,
        path: `/scripts/actions/${actionIndex}/functionMappings`,
        value: [{
          source: "jQuery validate=required onLoad",
          target: "form.fields[].props.required",
          basis: "static-form-prop",
          reviewRequired: false
        }]
      },
      {
        ...common,
        path: `/scripts/actions/${actionIndex}/coverage`,
        value: action.coverage
      }
    ];
  });
}
