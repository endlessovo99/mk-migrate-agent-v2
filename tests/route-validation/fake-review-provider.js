import { REVIEW_SCENARIOS } from "./manifest.js";
import { integrityError } from "./integrity.js";
import { reviewAuditedRowMarkerOrphan } from "./fake-review-scenarios/audited-row-marker-orphan.js";

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
    async review({ sourceDraft, dslDraft, reviewScope }) {
      if (scenario === "fail-if-called") {
        throw integrityError(
          "route.review.unexpected_call",
          "The review provider must not be called for a locally unrepairable workflow formula."
        );
      }
      const response = scenario === "audited-row-marker-orphan-noop"
        ? reviewAuditedRowMarkerOrphan({ sourceDraft, dslDraft, reviewScope })
        : {
            summary: scenario === "warning"
              ? "Accepted with one deterministic manual-review warning."
              : "Accepted by the deterministic offline Route reviewer.",
            patches: [
              ...staticPropertyClosurePatches(dslDraft, reviewScope),
              ...nativeFormRuleClosurePatches(dslDraft, reviewScope),
              ...gatedFormRuleScriptPatches(sourceDraft, dslDraft, reviewScope)
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

function gatedFormRuleScriptPatches(sourceDraft, dslDraft, reviewScope) {
  const sourceRules = new Map(
    (sourceDraft?.formRules?.linkage || []).map((rule) => [rule.id, rule])
  );
  const primaryMarkerByAlias = new Map();
  for (const row of dslDraft?.form?.layout?.mkTree || []) {
    const markers = (row.sourceMarkers || []).filter(Boolean);
    for (const marker of markers) primaryMarkerByAlias.set(marker, markers[0]);
  }

  return (dslDraft?.scripts?.actions || []).flatMap((action, actionIndex) => {
    if (!actionIsInReviewScope(actionIndex, reviewScope)) return [];
    const residuals = Array.isArray(action.coverage?.residuals) ? action.coverage.residuals : [];
    if (
      action.event !== "onChange" ||
      action.scope !== "control" ||
      !residuals.length ||
      residuals.some((residual) => residual.code !== "script.residual.form_rule_needs_review")
    ) {
      return [];
    }
    const rules = residuals
      .map((residual) => sourceRules.get(residual.evidence))
      .filter(Boolean);
    if (rules.length !== residuals.length || rules.some((rule) => !rule.effects?.length || !rule.else?.length)) {
      return [];
    }

    const functionText = buildGatedRuleFunction(rules, primaryMarkerByAlias);
    const common = {
      op: "replace",
      sourceRefs: action.sourceRefs || [],
      evidence: ["The source-gated row rule is translated to MKXFORM.setFieldAttr inside the immutable action runWhen guard."],
      confidence: 0.99,
      rationale: "Preserve the complete gated show/hide and required/non-required branches as reviewed JavaScript."
    };
    return [
      { ...common, path: `/scripts/actions/${actionIndex}/function`, value: functionText },
      { ...common, path: `/scripts/actions/${actionIndex}/translationStatus`, value: "mapped" },
      {
        ...common,
        path: `/scripts/actions/${actionIndex}/functionMappings`,
        value: [{
          source: "gated legacy row visibility/required behavior",
          target: "MKXFORM.setFieldAttr",
          basis: "semantic-translation",
          reviewRequired: false
        }]
      },
      {
        ...common,
        path: `/scripts/actions/${actionIndex}/coverage`,
        value: { status: "translated", nativeRules: [], residuals: [] }
      }
    ];
  });
}

function buildGatedRuleFunction(rules, primaryMarkerByAlias) {
  const lines = [
    "function onChange(value, rowNum, parentRowNum) {",
    "  var selectedValue = Array.isArray(value) ? value[0] : value",
    "  selectedValue = selectedValue == null ? \"\" : String(selectedValue)"
  ];
  for (const rule of rules) {
    lines.push(`  if (${ruleConditionExpression(rule)}) {`);
    lines.push(...ruleEffectLines(rule.effects, primaryMarkerByAlias, "    "));
    lines.push("  } else {");
    lines.push(...ruleEffectLines(rule.else, primaryMarkerByAlias, "    "));
    lines.push("  }");
  }
  lines.push("}");
  return lines.join("\n");
}

function ruleConditionExpression(rule) {
  const clauses = (rule.when || []).map((condition) => {
    const value = JSON.stringify(condition.value ?? "");
    if (condition.op === "eq") return `selectedValue === ${value}`;
    if (condition.op === "ne") return `selectedValue !== ${value}`;
    if (condition.op === "contains") return `selectedValue.indexOf(${value}) >= 0`;
    if (condition.op === "notContains") return `selectedValue.indexOf(${value}) < 0`;
    if (condition.op === "empty") return "selectedValue === \"\"";
    if (condition.op === "notEmpty") return "selectedValue !== \"\"";
    throw integrityError("route.review.form_rule_operator_unsupported", `Unsupported fake-review form-rule operator: ${condition.op}`);
  });
  const joiner = rule.logic === "or" ? " || " : " && ";
  return clauses.length > 1 ? `(${clauses.join(joiner)})` : clauses[0];
}

function ruleEffectLines(effects, primaryMarkerByAlias, indent) {
  return effects.flatMap((effect) => {
    const target = primaryMarkerByAlias.get(effect.target) || effect.target;
    const attribute = effect.type === "visible"
      ? (effect.value ? 5 : 4)
      : (effect.value ? 3 : 6);
    return `${indent}MKXFORM.setFieldAttr(${JSON.stringify(target)}, ${attribute})`;
  });
}

function nativeFormRuleClosurePatches(dslDraft, reviewScope) {
  return (dslDraft?.scripts?.actions || []).flatMap((action, actionIndex) => {
    if (!actionIsInReviewScope(actionIndex, reviewScope)) return [];
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

function staticPropertyClosurePatches(dslDraft, reviewScope) {
  return (dslDraft?.scripts?.actions || []).flatMap((action, actionIndex) => {
    if (!actionIsInReviewScope(actionIndex, reviewScope)) return [];
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

function actionIsInReviewScope(actionIndex, reviewScope) {
  return reviewScope === undefined ||
    (Array.isArray(reviewScope.actionIndexes) && reviewScope.actionIndexes.includes(actionIndex));
}
