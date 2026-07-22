import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyEvidenceBackedPatches,
  collectSourceRefs
} from "../../src/agent-review/review-validation.js";
import { buildFormRuleRefIndex, resolveEffectTarget } from "../../src/dsl/form-rules.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import {
  formAttr,
  persistAndVerify,
  projectTemplate,
  xformConfig
} from "../helpers/persistence.js";

const fixture = "tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac";

describe("detail footer total Route case", () => {
  it("keeps footer totals as main aggregates without duplicating row-scoped detail columns", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const cases = [
      {
        fieldId: "fd_3c671a66ad66ca",
        tableId: "fd_3c6719a6f103f0",
        sourceFieldId: "fd_3c671a5ca464a6"
      },
      {
        fieldId: "fd_3c671e0549112e",
        tableId: "fd_3c671d59b7128e",
        sourceFieldId: "fd_3c671def230168"
      },
      {
        fieldId: "fd_3c6b0b37893d0a",
        tableId: "fd_3c6b0abc7c89cc",
        sourceFieldId: "fd_3c6b0b32e42888"
      }
    ];

    for (const testCase of cases) {
      const main = dsl.form.fields.find((field) =>
        field.type !== "detailTable" && field.id === testCase.fieldId
      );
      const detail = dsl.form.fields.find((field) =>
        field.type === "detailTable" && field.id === testCase.tableId
      );

      assert.deepEqual(main?.props?.calculation, {
        kind: "aggregate",
        operation: "sum",
        tableId: testCase.tableId,
        fieldId: testCase.sourceFieldId
      });
      assert.equal(
        detail?.columns.some((column) => column.id === testCase.fieldId),
        false,
        `${testCase.fieldId} must not be both a main total and a detail column`
      );
      assert.equal(
        dsl.scripts.calculationDecisions.some((decision) =>
          decision.targetRefs?.includes(`${testCase.tableId}.${testCase.fieldId}`)
        ),
        false,
        `${testCase.fieldId} must have only the main aggregate decision`
      );
    }
  });

  it("preserves the complete mutually exclusive visibility truth table", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(sourceDraft);
    const linkage = sourceDraft.formRules.linkage;
    const refIndex = buildFormRuleRefIndex(dsl.form);
    const expectedVisible = {
      A: [
        "fd_3c6719a6f103f0",
        "fd_3c671a66ad66ca",
        "fd_3c671ba820a120",
        "fd_3c671bd534a3ee"
      ],
      B: ["fd_3c671d59b7128e", "fd_3c671e0549112e"],
      C: ["fd_3c67388d66e9b0"],
      D: ["fd_3c6b0abc7c89cc", "fd_3c6b0b37893d0a"],
      AB: [
        "fd_3c6719a6f103f0",
        "fd_3c671a66ad66ca",
        "fd_3c671ba820a120",
        "fd_3c671bd534a3ee"
      ],
      BA: [
        "fd_3c6719a6f103f0",
        "fd_3c671a66ad66ca",
        "fd_3c671ba820a120",
        "fd_3c671bd534a3ee"
      ],
      "": []
    };

    assert.equal(linkage.length, 4);
    assert.equal(linkage.every((rule) => rule.else?.length === 2), true);
    for (const [value, expected] of Object.entries(expectedVisible)) {
      const matching = linkage.filter((rule) => ruleMatches(rule, value));
      assert.equal(matching.length, value ? 1 : 0, `${value || "empty"} must match the original branch priority`);
      const effectiveEffects = linkage.flatMap((rule) =>
        ruleMatches(rule, value) ? rule.effects : rule.else
      );
      assert.deepEqual(
        resolvedEffectFieldIds(effectiveEffects, refIndex, "visible"),
        expected.slice().sort(),
        `${value || "empty"} visibility`
      );
      assert.deepEqual(
        resolvedEffectFieldIds(effectiveEffects, refIndex, "required"),
        expected.slice().sort(),
        `${value || "empty"} required state`
      );
    }

    const onChange = dsl.scripts.actions.find((action) =>
      action.event === "onChange" && action.controlId === "fd_3c66895473ff5c"
    );
    assert.ok(onChange, "the source value-change callback must not be dropped");
    assert.equal(onChange.coverage.status, "partial");
    assert.deepEqual(onChange.coverage.nativeRules, linkage.map((rule) => rule.id));
    assert.equal(
      onChange.coverage.residuals.some((item) =>
        item.code === "script.residual.field_value_assignment" &&
        item.target === "fd_3c6a790de91eb0"
      ),
      true
    );
    assert.equal(
      onChange.coverage.residuals.some((item) => item.code === "script.residual.form_rule_needs_review"),
      false
    );
  });

  it("resolves a split detail row marker across its detail table and footer total", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const refIndex = buildFormRuleRefIndex(dsl.form);
    const cases = [
      { marker: "fd_one_row", tableId: "fd_3c6719a6f103f0", totalId: "fd_3c671a66ad66ca" },
      { marker: "fd_two_row", tableId: "fd_3c671d59b7128e", totalId: "fd_3c671e0549112e" },
      { marker: "fd_four_row", tableId: "fd_3c6b0abc7c89cc", totalId: "fd_3c6b0b37893d0a" }
    ];

    for (const testCase of cases) {
      const sourceRow = dsl.form.layout.sourceGrid.rows.find((row) =>
        row.sourceMarkers?.includes(testCase.marker)
      );
      const segments = dsl.form.layout.mkTree.filter((row) => row.sourceRef === sourceRow?.sourceRef);
      const targetIds = resolveEffectTarget(refIndex, testCase.marker)?.targets.map((target) => target.id) || [];

      assert.equal(segments.length >= 2, true, `${testCase.marker} must retain its split source-row evidence`);
      assert.equal(
        segments.filter((row) => row.sourceMarkers?.includes(testCase.marker)).length,
        1,
        `${testCase.marker} must keep a single runtime marker owner`
      );
      assert.equal(targetIds.includes(testCase.tableId), true);
      assert.equal(targetIds.includes(testCase.totalId), true);
    }
  });

  it("materializes provable gated priority rules as view-status formulas", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(sourceDraft);
    const nativeRules = formAttr(projectTemplate(dsl)).formRule;

    assert.equal(dsl.formRules.linkage.length, 4);
    assert.deepEqual(dsl.formRules.review, {});
    assert.equal(
      dsl.formRules.linkage.every((rule) =>
        rule.meta.runWhen?.viewStatusIn?.join(",") === "add,edit" &&
        rule.meta.conditionSource === "event:value" &&
        rule.meta.sourceActionKey
      ),
      true
    );
    assert.equal(nativeRules.display.length, 8);
    assert.equal(nativeRules.require.length, 8);
    assert.equal(
      [...nativeRules.display, ...nativeRules.require].every((rule) => {
        const formula = rule.choices.items[0];
        return formula.condNodeType === "formula" &&
          formula.valueType === "formula" &&
          formula.value.type === "Eval" &&
          formula.value.varIds.join(",") === "fd_3c66895473ff5c" &&
          formula.value.script.includes("MKXFORM.viewStatus") &&
          formula.value.script.includes("${data.biz.fd_3c66895473ff5c}");
      }),
      true
    );
  });

  it("materializes priority guards and symmetric rollback when the same rules are ungated", () => {
    const dsl = ungatedVisibilityDraft();
    const nativeRules = formAttr(projectTemplate(dsl)).formRule;

    assert.equal(nativeRules.display.length, 8);
    assert.equal(nativeRules.require.length, 8);
    const bRuleId = "linkage.d_3c66895473ff5c.notContains.A.and.contains.B";
    const bDisplay = nativeRules.display.filter((rule) => rule.meta.sourceRuleId === bRuleId);
    const bWhen = bDisplay.find((rule) => rule.meta.branch === "when");
    const bElse = bDisplay.find((rule) => rule.meta.branch === "else");

    assert.equal(bWhen.condition, "1");
    assert.deepEqual(bWhen.choices.items.map((item) => item.operate), ["notInclude", "include"]);
    assert.equal(bWhen.result.every((item) => item.displayFlag === "display"), true);
    assert.equal(bElse.condition, "2");
    assert.deepEqual(bElse.choices.items.map((item) => item.operate), ["include", "notInclude"]);
    assert.equal(bElse.result.every((item) => item.displayFlag === "hide"), true);
    assert.equal(
      bWhen.result.some((item) => item.type === "main" && item.fieldName === "fd_3c671e0549112e"),
      true
    );

    const bRequire = nativeRules.require.filter((rule) => rule.meta.sourceRuleId === bRuleId);
    assert.deepEqual(
      bRequire.map((rule) => rule.result.find((item) => item.fieldName === "fd_3c671e0549112e")?.required),
      ["required", "non-required"]
    );
  });

  it("verifies aggregate and ungated-rule semantics through independent readback", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const healthyReadback = persistAndVerify(dsl).readback;
    assert.equal(healthyReadback.partitions.form, "verified");
    assert.equal(healthyReadback.partitions.rules, "verified");
    assert.equal(
      healthyReadback.diagnostics.some((item) => item.partition === "rules"),
      false
    );

    const ungatedDsl = ungatedVisibilityDraft();
    assert.equal(persistAndVerify(ungatedDsl).readback.partitions.rules, "verified");
    const mutated = persistAndVerify(ungatedDsl, {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        const bWhen = attr.formRule.display.find((rule) =>
          rule.meta.sourceRuleId === "linkage.d_3c66895473ff5c.notContains.A.and.contains.B" &&
          rule.meta.branch === "when"
        );
        bWhen.result = bWhen.result.filter((item) => item.fieldName !== "fd_3c671e0549112e");
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(mutated.readback.partitions.rules, "mismatch");
    assert.equal(
      mutated.readback.diagnostics.some((item) => item.code === "readback.form_rules.semantic_missing"),
      true
    );

    const missingAggregate = persistAndVerify(dsl, {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.formRule.compute = attr.formRule.compute.filter((rule) =>
          rule.meta?.sourceFieldId !== "fd_3c671e0549112e"
        );
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(missingAggregate.readback.partitions.form, "mismatch");
    assert.equal(
      missingAggregate.readback.diagnostics.some((item) =>
        item.code === "readback.form.prop_calculation_mismatch"
      ),
      true
    );
  });

  it("binds native visibility coverage only to its exact action and preserves helper residuals", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(sourceDraft);
    const sourceRef = sourceDraft.formRules.linkage[0].meta.sourceJsp;
    const nativeRules = sourceDraft.formRules.linkage
      .filter((rule) => rule.meta.sourceJsp === sourceRef)
      .map((rule) => rule.id);
    const onLoadIndex = dsl.scripts.actions.findIndex((action) =>
      action.event === "onLoad" && action.sourceRefs.includes(sourceRef)
    );
    const onChangeIndex = dsl.scripts.actions.findIndex((action) =>
      action.event === "onChange" && action.controlId === "fd_3c66895473ff5c"
    );
    const options = {
      sourceDraft,
      sourceRefs: collectSourceRefs(sourceDraft)
    };

    assert.equal(nativeRules.length, 4);
    assert.notEqual(onLoadIndex, -1);
    assert.notEqual(onChangeIndex, -1);

    const moved = applyEvidenceBackedPatches(dsl, [reviewCoveragePatch(
      onLoadIndex,
      sourceRef,
      nativeRules
    )], options);
    assert.equal(moved.ok, false);
    assert.equal(
      moved.diagnostics.some((item) => item.code === "agent.patch.native_rule_action_mismatch"),
      true
    );

    const reused = applyEvidenceBackedPatches(dsl, [reviewCoveragePatch(
      onChangeIndex,
      sourceRef,
      nativeRules
    )], options);
    assert.equal(reused.ok, false);
    assert.equal(
      reused.diagnostics.some((item) => item.code === "agent.patch.deterministic_residual_omitted"),
      true
    );
  });

  it("accepts and reads back only complete guarded edit, change, and view mappings", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(sourceDraft);
    const actionIndexes = {
      editLoad: dsl.scripts.actions.findIndex((action) =>
        action.event === "onLoad" && action.runWhen?.viewStatusIn?.includes("edit")
      ),
      change: dsl.scripts.actions.findIndex((action) => action.event === "onChange"),
      viewLoad: dsl.scripts.actions.findIndex((action) =>
        action.event === "onLoad" && action.runWhen?.viewStatusIn?.includes("view")
      )
    };
    assert.equal(Object.values(actionIndexes).every((index) => index >= 0), true);
    const patches = [
      ...reviewScriptPatches(
        actionIndexes.editLoad,
        dsl.scripts.actions[actionIndexes.editLoad],
        loadVisibilityFunction("fd_3c66895473ff5c", true)
      ),
      ...reviewScriptPatches(
        actionIndexes.change,
        dsl.scripts.actions[actionIndexes.change],
        changeHelperFunction("fd_3c6a790de91eb0")
      ),
      ...reviewScriptPatches(
        actionIndexes.viewLoad,
        dsl.scripts.actions[actionIndexes.viewLoad],
        loadVisibilityFunction("fd_3c6a790de91eb0", false)
      )
    ];
    const reviewed = applyEvidenceBackedPatches(dsl, patches, {
      sourceDraft,
      sourceRefs: collectSourceRefs(sourceDraft)
    });

    assert.equal(reviewed.ok, true, JSON.stringify(reviewed.diagnostics));
    assert.equal(
      reviewed.dslDraft.scripts.actions.every((action) =>
        action.translationStatus === "mapped" && action.coverage.status === "translated"
      ),
      true
    );

    const readback = persistAndVerify(reviewed.dslDraft).readback;
    assert.equal(readback.partitions.form, "verified");
    assert.equal(readback.partitions.rules, "verified");
    assert.equal(readback.partitions.scripts, "verified");
    assert.equal(readback.form.scripts.actionCount, 3);
    assert.equal(readback.form.scripts.persistedActionCount, 2);
    assert.equal(readback.form.scripts.actions.every((action) => action.hasCanonicalGuard), true);
    assert.deepEqual(
      readback.form.scripts.actions.map((action) => action.guardViewStatusIn).sort(),
      [["add", "edit"], ["add", "edit"], ["view"]].sort()
    );
  });
});

function ungatedVisibilityDraft() {
  const sourceDraft = structuredClone(cleanSourceFile(fixture));
  for (const rule of sourceDraft.formRules.linkage) {
    delete rule.meta.runWhen;
  }
  sourceDraft.scripts = { ...sourceDraft.scripts, sources: [] };
  return draftSourceDraft(sourceDraft);
}

function reviewCoveragePatch(actionIndex, sourceRef, nativeRules) {
  return {
    op: "replace",
    path: `/scripts/actions/${actionIndex}/coverage`,
    value: { status: "covered", nativeRules, residuals: [] },
    sourceRefs: [sourceRef],
    evidence: ["Proposed native form-rule coverage for the source visibility behavior."],
    confidence: 0.95,
    rationale: "Exercise the Agent Review coverage trust boundary."
  };
}

function reviewScriptPatches(actionIndex, action, functionText) {
  const common = {
    op: "replace",
    sourceRefs: action.sourceRefs,
    evidence: ["Complete guarded row behavior translated from the action-local JSP source."],
    confidence: 0.99,
    rationale: "Preserve every gated visibility, required-state, and helper-value branch."
  };
  return [
    { ...common, path: `/scripts/actions/${actionIndex}/function`, value: functionText },
    { ...common, path: `/scripts/actions/${actionIndex}/translationStatus`, value: "mapped" },
    {
      ...common,
      path: `/scripts/actions/${actionIndex}/functionMappings`,
      value: [{
        source: "legacy gated row and helper behavior",
        target: action.event === "onChange"
          ? "MKXFORM.setValue helper synchronization"
          : "MKXFORM.setFieldAttr + MKXFORM.getValue",
        basis: "semantic-translation",
        reviewRequired: false
      }]
    },
    {
      ...common,
      path: `/scripts/actions/${actionIndex}/coverage`,
      value: {
        status: "translated",
        nativeRules: action.coverage.nativeRules || [],
        residuals: []
      }
    }
  ];
}

function loadVisibilityFunction(valueFieldId, requiredWhenVisible) {
  const names = { A: "one", B: "two", C: "three", D: "four" };
  return [
    "function onLoad() {",
    `  var rawValue = MKXFORM.getValue(${JSON.stringify(valueFieldId)})`,
    "  var selectedValue = Array.isArray(rawValue) ? rawValue[0] : rawValue",
    ...Object.entries(names).map(([value, name]) =>
      `  var show${capitalize(name)} = selectedValue === ${JSON.stringify(value)}`
    ),
    ...Object.values(names).flatMap((name) => {
      const variable = `show${capitalize(name)}`;
      const marker = `fd_${name}_row`;
      return [
        `  MKXFORM.setFieldAttr(${JSON.stringify(marker)}, ${variable} ? 5 : 4)`,
        requiredWhenVisible
          ? `  MKXFORM.setFieldAttr(${JSON.stringify(marker)}, ${variable} ? 3 : 6)`
          : `  MKXFORM.setFieldAttr(${JSON.stringify(marker)}, 6)`
      ];
    }),
    "}"
  ].join("\n");
}

function changeHelperFunction(helperFieldId) {
  const values = ["A", "B", "C", "D"];
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    "  var selectedValue = Array.isArray(value) ? value[0] : value",
    ...values.flatMap((value, index) => [
      `  ${index === 0 ? "if" : "else if"} (String(selectedValue || \"\").indexOf(${JSON.stringify(value)}) >= 0) {`,
      `    MKXFORM.setValue(${JSON.stringify(helperFieldId)}, ${JSON.stringify(value)})`,
      "  }"
    ]),
    "  else {",
    `    MKXFORM.setValue(${JSON.stringify(helperFieldId)}, \"\")`,
    "  }",
    "}"
  ].join("\n");
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function ruleMatches(rule, value) {
  const matches = (rule.when || []).map((condition) => {
    if (condition.op === "contains") return value.includes(condition.value);
    if (condition.op === "notContains") return !value.includes(condition.value);
    if (condition.op === "eq") return value === condition.value;
    if (condition.op === "ne") return value !== condition.value;
    return false;
  });
  return rule.logic === "or" ? matches.some(Boolean) : matches.every(Boolean);
}

function resolvedEffectFieldIds(effects, refIndex, type) {
  const state = new Map();
  for (const effect of effects || []) {
    if (effect.type !== type) continue;
    for (const target of resolveEffectTarget(refIndex, effect.target)?.targets || []) {
      assert.equal(state.has(target.id), false, `${type}:${target.id} must be controlled by only one lowered branch`);
      state.set(target.id, effect.value);
    }
  }
  return [...state.entries()]
    .filter(([, value]) => value === true)
    .map(([fieldId]) => fieldId)
    .sort();
}
