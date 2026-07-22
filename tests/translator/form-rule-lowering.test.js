import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import {
  analyzeLegacyScriptFormRules,
  sourceFormRulesFromLegacyScripts
} from "../../src/translator/sysform-form-rules.js";
import { draftMkScriptsFromSourceScripts } from "../../src/translator/sysform-jsp-scripts.js";
import { localCorpusIt } from "../helpers/local-corpus.js";

const targetFixture = "tests/fixtures/source/1670297c984b45009eb5b1e444d9957d";

describe("legacy JSP native form-rule lowering", () => {
  it("rejects a declared condition variable that is unrelated to the onChange input", () => {
    const analysis = analyzeLegacyScriptFormRules({
      sourceRef: "source.form.jsp.unrelated-condition",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          var wrong = "A";
          if (wrong.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
          }
        });
      `
    });

    assert.deepEqual(analysis.linkage, []);
    assert.equal(
      analysis.residuals.some((item) => item.code === "script.residual.form_rule_condition_source_unproven"),
      true
    );
  });

  it("accepts provable renaming, array-first normalization, and String derivation of the onChange input", () => {
    const analysis = analyzeLegacyScriptFormRules({
      sourceRef: "source.form.jsp.derived-condition",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("fd_trigger", function(inputValue) {
          const renamed = inputValue;
          const firstValue = Array.isArray(renamed) ? renamed[0] : renamed;
          const textValue = String(firstValue || "");
          if (textValue.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
          }
        });
      `
    });

    assert.equal(analysis.linkage.length, 1);
    assert.deepEqual(analysis.linkage[0].when, [
      { field: "fd_trigger", op: "contains", value: "A" }
    ]);
    assert.equal(analysis.linkage[0].meta.conditionSource, "event:value");
    assert.equal(analysis.linkage[0].meta.nativeProjection?.kind, "view-status-formula");
    assert.deepEqual(analysis.linkage[0].meta.conditionSemantics, [{
      origin: "event:value",
      transforms: ["array-first", "default-empty", "string"],
      predicate: "indexOf"
    }]);
    assert.equal(
      analysis.residuals.some((item) => item.code === "script.residual.form_rule_behavior_uncovered"),
      false
    );
  });

  it("keeps non-native callback side effects as residual behavior instead of omitting the action", () => {
    const source = {
      id: "native-rule-with-side-effect",
      sourceRef: "source.form.jsp.native-rule-with-side-effect",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          const renamed = value;
          const textValue = String(renamed || "");
          if (textValue.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
            doUnrelatedWrite();
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
          }
        });
      `,
      functionAudit: {
        matched: [],
        violations: [{ name: "doUnrelatedWrite" }]
      }
    };
    const sourceScripts = { source: "sysform-jsp", sources: [source] };
    const analysis = analyzeLegacyScriptFormRules(source);
    const formRules = sourceFormRulesFromLegacyScripts(sourceScripts);
    const scripts = draftMkScriptsFromSourceScripts(sourceScripts, { formRules });
    const action = scripts.actions.find((item) => item.event === "onChange");

    assert.equal(analysis.linkage.length, 1);
    assert.equal(
      analysis.residuals.some((item) => item.code === "script.residual.form_rule_behavior_uncovered"),
      true
    );
    assert.equal(action.translationStatus, "needs_review");
    assert.equal(action.coverage.status, "partial");
    assert.notEqual(action.function, "");
    assert.equal(
      action.coverage.residuals.some((item) => item.code === "script.residual.form_rule_behavior_uncovered"),
      true
    );
  });

  it("rejects a shadowed AttachXFormValueChangeEventById as a platform onChange source", () => {
    const source = {
      id: "shadowed-value-change",
      sourceRef: "source.form.jsp.shadowed-value-change",
      displayGate: "xform:editShow",
      javascript: `
        function AttachXFormValueChangeEventById(id, callback) {
          callback("A");
        }
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          if (value.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
          }
        });
      `,
      functionAudit: { matched: [], violations: [] }
    };
    const sourceScripts = { source: "sysform-jsp", sources: [source] };
    const analysis = analyzeLegacyScriptFormRules(source);
    const formRules = sourceFormRulesFromLegacyScripts(sourceScripts);
    const scripts = draftMkScriptsFromSourceScripts(sourceScripts, { formRules });

    assert.deepEqual(analysis.linkage, []);
    assert.equal(formRules, undefined);
    assert.equal(
      analysis.residuals.some((item) => item.code === "script.residual.value_change_binding_unproven"),
      true
    );
    assert.equal(scripts.actions.some((item) => item.event === "onChange"), false);
    assert.equal(scripts.actions.every((item) => item.translationStatus !== "omitted"), true);
  });

  it("does not lower calls to a shadowed row-state helper", () => {
    for (const [label, javascript] of [
      ["outer", `
        function common_dom_row_set_show_required_reset() {}
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          if (value.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
          }
        });
      `],
      ["callback", `
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          function common_dom_row_set_show_required_reset() {}
          if (value.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
          }
        });
      `]
    ]) {
      const analysis = analyzeLegacyScriptFormRules({
        sourceRef: `source.form.jsp.shadowed-row-helper-${label}`,
        displayGate: "xform:editShow",
        javascript
      });

      assert.deepEqual(analysis.linkage, [], label);
      assert.equal(
        analysis.residuals.some((item) => item.code === "script.residual.form_rule_chain_untranslated"),
        true,
        label
      );
    }
  });

  it("ignores conditional and row-helper text inside comments and string literals", () => {
    const analysis = analyzeLegacyScriptFormRules({
      sourceRef: "source.form.jsp.non-code-text",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          const example = "if (value.indexOf('STRING') >= 0) { common_dom_row_set_show_required_reset('row_string', true, true, false); } else { common_dom_row_set_show_required_reset('row_string', false, false, false); }";
          const template = \`if (value.indexOf("TEMPLATE") >= 0) { common_dom_row_set_show_required_reset("row_template", true, true, false); } else { common_dom_row_set_show_required_reset("row_template", false, false, false); }\`;
          // if (value.indexOf("LINE") >= 0) { common_dom_row_set_show_required_reset("row_line", true, true, false); } else { common_dom_row_set_show_required_reset("row_line", false, false, false); }
          /*
            if (value.indexOf("COMMENT") >= 0) {
              common_dom_row_set_show_required_reset("row_comment", true, true, false);
            } else {
              common_dom_row_set_show_required_reset("row_comment", false, false, false);
            }
          */
          if (value.indexOf("REAL") >= 0) {
            common_dom_row_set_show_required_reset("row_real", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_real", false, false, false);
          }
        });
      `
    });

    assert.equal(analysis.linkage.length, 1);
    assert.deepEqual(analysis.linkage[0].when, [
      { field: "fd_trigger", op: "contains", value: "REAL" }
    ]);
    assert.deepEqual(
      analysis.linkage[0].effects.map((effect) => effect.target),
      ["row_real", "row_real"]
    );
    assert.equal(
      analysis.residuals.some((item) => item.code.startsWith("script.residual.form_rule_")),
      false
    );
  });

  it("keeps punctuation-distinct condition values in distinct rule ids", () => {
    const analysis = analyzeLegacyScriptFormRules({
      sourceRef: "source.form.jsp.condition-id-encoding",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          if (value === "A/B") {
            common_dom_row_set_show_required_reset("row_slash", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_slash", false, false, false);
          }
          if (value === "A B") {
            common_dom_row_set_show_required_reset("row_space", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_space", false, false, false);
          }
        });
      `
    });

    assert.equal(analysis.linkage.length, 2);
    assert.equal(new Set(analysis.linkage.map((rule) => rule.id)).size, 2);
    assert.deepEqual(
      analysis.linkage.map((rule) => ({
        value: rule.when[0].value,
        target: rule.effects[0].target
      })),
      [
        { value: "A/B", target: "row_slash" },
        { value: "A B", target: "row_space" }
      ]
    );
  });

  it("rejects aliases declared after the branch or reassigned before use", () => {
    for (const [label, body] of [
      ["declared-after", `
        if (alias.indexOf("A") >= 0) {
          common_dom_row_set_show_required_reset("row_a", true, true, false);
        } else {
          common_dom_row_set_show_required_reset("row_a", false, false, false);
        }
        const alias = value;
      `],
      ["reassigned", `
        let alias = value;
        alias = "A";
        if (alias.indexOf("A") >= 0) {
          common_dom_row_set_show_required_reset("row_a", true, true, false);
        } else {
          common_dom_row_set_show_required_reset("row_a", false, false, false);
        }
      `]
    ]) {
      const analysis = analyzeLegacyScriptFormRules({
        sourceRef: `source.form.jsp.${label}`,
        displayGate: "xform:editShow",
        javascript: `AttachXFormValueChangeEventById("fd_trigger", function(value) {${body}});`
      });
      assert.deepEqual(analysis.linkage, [], label);
      assert.equal(
        analysis.residuals.some((item) => item.code === "script.residual.form_rule_condition_source_unproven"),
        true,
        label
      );
    }
  });

  it("fails closed when the same native rule id comes from different callbacks", () => {
    const analysis = analyzeLegacyScriptFormRules({
      sourceRef: "source.form.jsp.callback-collision",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          if (value.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
          }
        });
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          if (value.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_b", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_b", false, false, false);
          }
        });
      `
    });

    assert.deepEqual(analysis.linkage, []);
    assert.equal(
      analysis.residuals.some((item) => item.code === "script.residual.form_rule_action_identity_collision"),
      true
    );
  });

  it("keeps rule ids globally unique across different JSP actions", () => {
    const sources = [
      sourceWithCondition("global-id-one", "value.indexOf(\"A\") >= 0", "row_one", "xform:editShow"),
      sourceWithCondition("global-id-two", "value.indexOf(\"A\") >= 0", "row_two", "xform:editShow")
    ];
    const sourceFormRules = sourceFormRulesFromLegacyScripts({ sources });
    const sourceDraft = {
      version: "2.0-source-draft",
      artifact: "source-draft",
      source: { kind: "sysform-template", path: "synthetic", sourceId: "synthetic" },
      template: { name: "global-rule-ids" },
      form: {
        controls: [
          {
            id: "fd_trigger",
            title: "Trigger",
            sourceType: "String",
            componentHint: "radio",
            sourceProps: { designerId: "fd_trigger" }
          },
          {
            id: "fd_one",
            title: "One",
            sourceType: "String",
            componentHint: "text",
            sourceProps: { designerId: "fd_one" }
          },
          {
            id: "fd_two",
            title: "Two",
            sourceType: "String",
            componentHint: "text",
            sourceProps: { designerId: "fd_two" }
          }
        ],
        layout: {
          rows: [
            {
              id: "trigger-row",
              cells: [{ id: "trigger-cell", references: [{ referenceId: "fd_trigger" }] }]
            },
            {
              id: "one-row",
              sourceMarkers: ["row_one"],
              cells: [{ id: "one-cell", references: [{ referenceId: "fd_one" }] }]
            },
            {
              id: "two-row",
              sourceMarkers: ["row_two"],
              cells: [{ id: "two-cell", references: [{ referenceId: "fd_two" }] }]
            }
          ]
        }
      },
      formRules: sourceFormRules,
      scripts: { sources },
      issues: []
    };

    assert.equal(sourceFormRules.linkage.length, 2);
    assert.equal(new Set(sourceFormRules.linkage.map((rule) => rule.id)).size, 2);

    const dslDraft = draftSourceDraft(sourceDraft);
    assert.equal(dslDraft.formRules.linkage.length, 2);
    assert.equal(new Set(dslDraft.formRules.linkage.map((rule) => rule.id)).size, 2);
    assert.deepEqual(
      dslDraft.formRules.linkage.map((rule) => ({
        sourceJsp: rule.meta.sourceJsp,
        target: rule.effects[0].target
      })),
      [
        { sourceJsp: "source.form.jsp.global-id-one", target: "row_one" },
        { sourceJsp: "source.form.jsp.global-id-two", target: "row_two" }
      ]
    );
    const actions = dslDraft.scripts.actions.filter((action) => action.event === "onChange");
    assert.equal(actions.length, 2);
    assert.equal(actions.every((action) => action.translationStatus === "omitted"), true);
    for (const action of actions) {
      const ownRule = dslDraft.formRules.linkage.find((rule) =>
        rule.meta.sourceActionKey === action.sourceActionKey
      );
      assert.ok(ownRule);
      assert.deepEqual(action.coverage.nativeRules, [ownRule.id]);
    }
  });

  it("fails closed when one callback writes conflicting values in one native branch", () => {
    const analysis = analyzeLegacyScriptFormRules({
      sourceRef: "source.form.jsp.branch-effect-conflict",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          if (value.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
          }
          if (value.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
          } else {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
          }
        });
      `
    });

    assert.deepEqual(analysis.linkage, []);
    assert.equal(
      analysis.residuals.some((item) => item.code === "script.residual.form_rule_effect_conflict"),
      true
    );
  });

  it("lowers a complete else-if chain into mutually exclusive native branches", () => {
    const formRules = sourceFormRulesFromLegacyScripts({
      sources: [{
        id: "multi-branch",
        sourceRef: "source.form.jsp.multi-branch",
        displayGate: "xform:editShow",
        javascript: `
          AttachXFormValueChangeEventById("fd_trigger", function(value) {
            if (value.indexOf("A") >= 0) {
              common_dom_row_set_show_required_reset("row_a", true, true, false);
              common_dom_row_set_show_required_reset("row_b", false, false, false);
            } else if (value.indexOf("B") >= 0) {
              common_dom_row_set_show_required_reset("row_a", false, false, false);
              common_dom_row_set_show_required_reset("row_b", true, true, false);
            } else {
              common_dom_row_set_show_required_reset("row_a", false, false, false);
              common_dom_row_set_show_required_reset("row_b", false, false, false);
            }
          });
        `
      }]
    });

    assert.equal(formRules.linkage.length, 2);
    assert.deepEqual(
      formRules.linkage.map((rule) => rule.when),
      [
        [{ field: "fd_trigger", op: "contains", value: "A" }],
        [
          { field: "fd_trigger", op: "notContains", value: "A" },
          { field: "fd_trigger", op: "contains", value: "B" }
        ]
      ]
    );
    assert.equal(formRules.linkage.every((rule) => rule.logic === "and"), true);
    assert.equal(formRules.linkage.every((rule) => rule.else?.length === 2), true);
    assert.deepEqual(
      formRules.linkage.map((rule) => rule.effects.filter((effect) => effect.type === "visible" && effect.value).map((effect) => effect.target)),
      [["row_a"], ["row_b"]]
    );
    assert.deepEqual(
      formRules.linkage.map((rule) => rule.else.filter((effect) => effect.value === false).map((effect) => `${effect.type}:${effect.target}`)),
      [["visible:row_a", "required:row_a"], ["visible:row_b", "required:row_b"]]
    );
  });

  it("keeps unsupported row-effect chains as explicit residual coverage", () => {
    const legacySource = {
      id: "mixed-branches",
      sourceRef: "source.form.jsp.mixed-branches",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          if (value.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
          }
          if (value.startsWith("B")) {
            common_dom_row_set_show_required_reset("row_b", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_b", false, false, false);
          }
        });
      `
    };
    const analysis = sourceFormRulesFromLegacyScripts({ sources: [legacySource] });

    assert.equal(analysis.linkage.length, 1);
    const sourceDraft = {
      version: "2.0-source-draft",
      artifact: "source-draft",
      source: { kind: "sysform-template", path: "synthetic", sourceId: "synthetic" },
      template: { name: "mixed-branch-coverage" },
      form: {
        controls: [{
          id: "fd_trigger",
          title: "Trigger",
          sourceType: "String",
          componentHint: "radio",
          sourceProps: { designerId: "fd_trigger" }
        }],
        layout: {
          rows: [
            {
              id: "row-a",
              sourceMarkers: ["row_a"],
              cells: [{ id: "cell-a", references: [{ referenceId: "fd_trigger" }] }]
            },
            {
              id: "row-b",
              sourceMarkers: ["row_b"],
              cells: [{ id: "cell-b", references: [{ referenceId: "fd_trigger" }] }]
            }
          ]
        }
      },
      formRules: analysis,
      scripts: { sources: [legacySource] },
      issues: []
    };

    const dslDraft = draftSourceDraft(sourceDraft);
    const action = dslDraft.scripts.actions.find((item) => item.event === "onChange");
    assert.equal(action.translationStatus, "needs_review");
    assert.equal(action.coverage.status, "partial");
    assert.equal(action.coverage.nativeRules.length, 1);
    assert.equal(
      action.coverage.residuals.some((item) => item.code === "script.residual.form_rule_chain_untranslated"),
      true
    );
    assert.equal(
      action.coverage.residuals.some((item) => item.code === "script.residual.form_rule_needs_review"),
      false
    );
  });

  it("does not count dynamic row-helper calls as native coverage", () => {
    const analysis = analyzeLegacyScriptFormRules({
      sourceRef: "source.form.jsp.dynamic-row",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          if (value.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
            common_dom_row_set_show_required_reset(dynamicRow, true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
            common_dom_row_set_show_required_reset(dynamicRow, false, false, false);
          }
        });
      `
    });

    assert.equal(analysis.linkage.length, 0);
    assert.equal(
      analysis.residuals.some((item) => item.code === "script.residual.form_rule_chain_untranslated"),
      true
    );
  });

  it("keeps reset-bearing row-helper calls out of native-only coverage", () => {
    const analysis = analyzeLegacyScriptFormRules({
      sourceRef: "source.form.jsp.reset-row",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          if (value.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", true, true, true);
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, true);
          }
        });
      `
    });

    assert.equal(analysis.linkage.length, 0);
    assert.equal(
      analysis.residuals.some((item) => item.code === "script.residual.form_rule_chain_untranslated"),
      true
    );
  });

  it("fails the whole chain closed when reset=false and reset=true calls affect the same target", () => {
    const analysis = analyzeLegacyScriptFormRules({
      sourceRef: "source.form.jsp.mixed-reset-row",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          if (value.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
            common_dom_row_set_show_required_reset("row_a", false, false, true);
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
          }
        });
      `
    });

    assert.deepEqual(analysis.linkage, []);
    assert.equal(
      analysis.residuals.some((item) => item.code === "script.residual.form_rule_chain_untranslated"),
      true
    );
  });

  it("does not truncate compound conditions into executable native rules", () => {
    const analysis = analyzeLegacyScriptFormRules({
      sourceRef: "source.form.jsp.compound-condition",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          if (value.indexOf("A") >= 0 && isReady()) {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
          }
        });
      `
    });

    assert.equal(analysis.linkage.length, 0);
    assert.equal(
      analysis.residuals.some((item) => item.code === "script.residual.form_rule_chain_untranslated"),
      true
    );
  });

  it("fails closed when different branch markers resolve to the same native target", () => {
    const legacySource = {
      id: "overlapping-markers",
      sourceRef: "source.form.jsp.overlapping-markers",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("fd_trigger", function(value) {
          if (value.indexOf("A") >= 0) {
            common_dom_row_set_show_required_reset("row_a", true, true, false);
            common_dom_row_set_show_required_reset("row_b", false, false, false);
          } else if (value.indexOf("B") >= 0) {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
            common_dom_row_set_show_required_reset("row_b", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("row_a", false, false, false);
            common_dom_row_set_show_required_reset("row_b", false, false, false);
          }
        });
      `
    };
    const sourceDraft = {
      version: "2.0-source-draft",
      artifact: "source-draft",
      source: { kind: "sysform-template", path: "synthetic", sourceId: "synthetic" },
      template: { name: "overlapping-marker-coverage" },
      form: {
        controls: [
          {
            id: "fd_trigger",
            title: "Trigger",
            sourceType: "String",
            componentHint: "radio",
            sourceProps: { designerId: "fd_trigger" }
          },
          {
            id: "fd_target",
            title: "Target",
            sourceType: "String",
            componentHint: "text",
            sourceProps: { designerId: "fd_target" }
          }
        ],
        layout: {
          rows: [
            {
              id: "trigger-row",
              cells: [{ id: "trigger-cell", references: [{ referenceId: "fd_trigger" }] }]
            },
            {
              id: "target-row",
              sourceMarkers: ["row_a", "row_b"],
              cells: [{ id: "target-cell", references: [{ referenceId: "fd_target" }] }]
            }
          ]
        }
      },
      formRules: sourceFormRulesFromLegacyScripts({ sources: [legacySource] }),
      scripts: { sources: [legacySource] },
      issues: []
    };

    const dslDraft = draftSourceDraft(sourceDraft);
    assert.deepEqual(dslDraft.formRules.linkage, []);
    assert.equal(
      dslDraft.formRules.review.excludedRules.every((rule) =>
        rule.code === "form_rule.baseline_delta_target_overlap"
      ),
      true
    );
    const action = dslDraft.scripts.actions.find((item) => item.event === "onChange");
    assert.equal(action.translationStatus, "needs_review");
    assert.equal(action.coverage.status, "uncovered");
  });

  it("preserves edit-gate evidence while translating regex tests to equality conditions", () => {
    const formRules = sourceFormRulesFromLegacyScripts({
      sources: [
        sourceWithCondition("single", "/[O]/.test(value)", "glqx_row", "xform:editShow"),
        sourceWithCondition("multi", "/[ADEFGIMN]/.test(value)", "gjqjqt_row", "xform:editShow"),
        sourceWithCondition("view", "value.indexOf(\"D\") >= 0", "fd_jsx_row", "xform:viewShow")
      ]
    });

    assert.equal(formRules.linkage.length, 2);
    const single = formRules.linkage.find((rule) => rule.meta.sourceJsp === "source.form.jsp.single");
    const multi = formRules.linkage.find((rule) => rule.meta.sourceJsp === "source.form.jsp.multi");

    assert.equal(single.logic, "and");
    assert.deepEqual(single.when, [{ field: "fd_trigger", op: "eq", value: "O" }]);
    const { sourceRuleIds, ...singleMeta } = single.meta;
    assert.deepEqual(singleMeta, {
      sourceJsp: "source.form.jsp.single",
      displayGate: "xform:editShow",
      runWhen: { viewStatusIn: ["add", "edit"] },
      conditionSource: "event:value",
      sourceActionKey: single.meta.sourceActionKey,
      nativeProjection: { kind: "view-status-formula", version: 1 },
      conditionSemantics: [{
        origin: "event:value",
        transforms: [],
        predicate: "regex-char-set",
        pattern: "[O]"
      }]
    });
    assert.equal(sourceRuleIds.length, 1);
    assert.match(sourceRuleIds[0], /^linkage\.fd_trigger\.eq\.O\.origin\.~[0-9a-f]+$/);
    assert.match(single.meta.sourceActionKey, /^source\.form\.jsp\.single#onChange@\d+$/);

    assert.equal(multi.logic, "or");
    assert.deepEqual(multi.when, ["A", "D", "E", "F", "G", "I", "M", "N"].map((value) => ({
      field: "fd_trigger",
      op: "eq",
      value
    })));
    assert.equal(formRules.linkage.some((rule) => rule.meta.sourceJsp === "source.form.jsp.view"), false);
  });

  it("canonicalizes Landray d_<hex> radio listeners onto matching fd_<hex> fields", () => {
    const legacySource = {
      id: "radio-alias",
      sourceRef: "source.form.jsp.radio-alias",
      displayGate: "xform:editShow",
      javascript: `
        AttachXFormValueChangeEventById("d_3c66895473ff5c", function(value) {
          if (value.indexOf("D") >= 0) {
            common_dom_row_set_show_required_reset("fd_four_row", true, true, false);
          } else {
            common_dom_row_set_show_required_reset("fd_four_row", false, false, false);
          }
        });
      `
    };
    const sourceDraft = {
      version: "2.0-source-draft",
      artifact: "source-draft",
      source: { kind: "sysform-template", path: "synthetic", sourceId: "synthetic" },
      template: { name: "alias-test" },
      form: {
        controls: [
          {
            id: "fd_3c66895473ff5c",
            title: "对应申请",
            sourceType: "String",
            componentHint: "radio",
            sourceProps: { designerId: "fd_3c66895473ff5c" }
          }
        ],
        layout: {
          rows: [
            {
              id: "row-1",
              sourceMarkers: ["fd_four_row"],
              cells: [{ id: "cell-1", references: [{ referenceId: "fd_3c66895473ff5c" }] }]
            }
          ]
        }
      },
      formRules: sourceFormRulesFromLegacyScripts({
        sources: [legacySource]
      }),
      scripts: { sources: [legacySource] },
      issues: []
    };

    const dslDraft = draftSourceDraft(sourceDraft);
    assert.equal(dslDraft.formRules.linkage.length, 1);
    assert.equal(dslDraft.formRules.linkage[0].source, "fd_3c66895473ff5c");
    assert.deepEqual(dslDraft.formRules.linkage[0].when, [{
      field: "fd_3c66895473ff5c",
      op: "contains",
      value: "D"
    }]);
    assert.equal(dslDraft.formRules.linkage[0].meta.conditionSource, "event:value");
    const action = dslDraft.scripts.actions.find((item) => item.event === "onChange");
    assert.equal(action.controlId, "fd_3c66895473ff5c");
    assert.equal(action.translationStatus, "omitted");
    assert.equal(action.coverage.status, "covered");
    assert.deepEqual(action.coverage.nativeRules, [dslDraft.formRules.linkage[0].id]);
  });

  it("excludes visibility rules whose resolved target is data-only", () => {
    const sourceDraft = {
      version: "2.0-source-draft",
      artifact: "source-draft",
      source: { kind: "sysform-template", path: "synthetic", sourceId: "synthetic" },
      template: { name: "data-only-rule-target" },
      form: {
        controls: [{
          id: "fd_trigger",
          title: "触发字段",
          sourceType: "String",
          componentHint: "radio",
          sourceProps: { designerId: "fd_trigger" }
        }],
        dataFields: [{
          id: "fd_hidden_helper",
          title: "隐藏辅助字段",
          sourceType: "String",
          sourceProps: { metadataAttributes: { canDisplay: "false" } }
        }],
        layout: {
          rows: [{
            id: "row-1",
            cells: [{ id: "cell-1", references: [{ referenceId: "fd_trigger" }] }]
          }]
        }
      },
      formRules: sourceFormRulesFromLegacyScripts({
        sources: [sourceWithCondition("data-only", "value.indexOf(\"Y\") >= 0", "fd_hidden_helper", "xform:editShow")]
      }),
      scripts: { sources: [] },
      issues: []
    };

    const dslDraft = draftSourceDraft(sourceDraft);

    assert.deepEqual(dslDraft.formRules.linkage, []);
    assert.deepEqual(dslDraft.formRules.review.excludedRules, [{
      ruleId: "linkage.fd_trigger.contains.Y",
      code: "form_rule.target_data_only",
      source: "fd_trigger",
      target: "fd_hidden_helper",
      detailTableRefs: [],
      sourceJsp: "source.form.jsp.data-only",
      displayGate: "xform:editShow",
      runWhen: { viewStatusIn: ["add", "edit"] },
      message: "Form rule visibility/required effects cannot target data-only fields."
    }]);
  });

  localCorpusIt("projects action-bound edit rules and fails conflicting native writers closed", () => {
    const sourceDraft = cleanSourceFile(targetFixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const sourceRules = sourceDraft.formRules.linkage;
    const executable = dslDraft.formRules.linkage.filter((rule) => rule.translationStatus === "executable");
    const excludedRules = dslDraft.formRules.review.excludedRules || [];

    assert.equal(sourceRules.length, 12);
    assert.equal(executable.length, 8);
    assert.equal(excludedRules.length, 4);
    assert.equal(dslDraft.formRules.linkage.length, 8);
    assert.equal(dslDraft.scripts.actions.length, 35);
    assert.equal(sourceRules.every((rule) => rule.meta.displayGate === "xform:editShow"), true);
    assert.equal(sourceRules.every((rule) => rule.meta.runWhen?.viewStatusIn.join(",") === "add,edit"), true);

    assert.equal(excludedRules.every((rule) => rule.code === "form_rule.native_target_writer_conflict"), true);
    assert.equal(excludedRules.every((rule) => rule.sourceJsp && rule.runWhen?.viewStatusIn.join(",") === "add,edit"), true);
    assert.equal(excludedRules.every((rule) => rule.target === "fd_jsx_row"), true);

    const detailActions = dslDraft.scripts.actions.filter((action) =>
      action.sourceRefs.includes("source.form.jsp.fd_3e502424ad4b9e.script.1") &&
      action.controlId === "fd_3268bfe94b435c"
    );
    assert.deepEqual(detailActions.map((action) => action.sourceActionKey), [
      "source.form.jsp.fd_3e502424ad4b9e.script.1#onChange@11",
      "source.form.jsp.fd_3e502424ad4b9e.script.1#onChange@430",
      "source.form.jsp.fd_3e502424ad4b9e.script.1#onChange@856"
    ]);
    assert.equal(detailActions.every((action) => action.coverage.status === "partial"), true);
    assert.deepEqual(detailActions.map((action) => action.coverage.nativeRules), [
      ["linkage.fd_3268bfe94b435c.contains.A"],
      ["linkage.fd_3268bfe94b435c.contains.B"],
      ["linkage.fd_3268bfe94b435c.contains.C"]
    ]);

    const serviceAction = actionFor(dslDraft, "source.form.jsp.fd_3e2435e961a482.script.1", "fd_38e47090921a54");
    assert.equal(serviceAction.coverage.status, "partial");
    assert.deepEqual(serviceAction.coverage.nativeRules, ["linkage.fd_38e47090921a54.eq.K"]);
    assert.deepEqual(serviceAction.runWhen, { viewStatusIn: ["add", "edit"] });

    const mergedActions = [
      ["source.form.jsp.fd_3da5a6abc177a2.script.1", "fd_3da33437ef5bfc"],
      ["source.form.jsp.fd_39f8cbfaefc12c.script.1", "fd_38e47377ddcd7e"],
      ["source.form.jsp.fd_39f8ebfc128778.script.1", "fd_38e4741c029f44"],
      ["source.form.jsp.fd_3f3165d0ab5bd6.script.1", "fd_3f3165cdddb2cc"]
    ].map(([sourceRef, controlId]) => actionFor(dslDraft, sourceRef, controlId));
    assert.equal(mergedActions.every((action) => action.coverage.status === "uncovered"), true);
    assert.equal(mergedActions.every((action) => action.coverage.nativeRules.length === 0), true);
    assert.equal(mergedActions.every((action) => action.coverage.residuals.some((item) => (
      item.code === "script.residual.form_rule_needs_review"
    ))), true);
    assert.equal(mergedActions.every((action) => action.runWhen?.viewStatusIn.join(",") === "add,edit"), true);
  });
});

function sourceWithCondition(id, condition, target, displayGate) {
  return {
    id,
    sourceRef: `source.form.jsp.${id}`,
    displayGate,
    javascript: `
      AttachXFormValueChangeEventById("fd_trigger", function(value) {
        if (${condition}) {
          common_dom_row_set_show_required_reset("${target}", true, true, false);
        } else {
          common_dom_row_set_show_required_reset("${target}", false, false, false);
        }
      });
    `
  };
}

function actionFor(dslDraft, sourceRef, controlId) {
  return dslDraft.scripts.actions.find((action) =>
    action.sourceRefs.includes(sourceRef) && action.controlId === controlId
  );
}
