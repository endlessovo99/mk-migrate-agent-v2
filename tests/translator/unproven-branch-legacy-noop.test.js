import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftMkScriptsFromSourceScripts } from "../../src/translator/sysform-jsp-scripts.js";

describe("unproven branch draft closure", () => {
  it("keeps unproven onChange alerts review-required instead of declaring a no-op", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [{
        id: "date-compare.script.1",
        sourceRef: "source.form.jsp.date-compare.script.1",
        javascript: [
          "AttachXFormValueChangeEventById('fd_end', function(value, domElement){",
          "  var startDate = GetXFormFieldById('fd_start')[0].value;",
          "  const date1 = new Date(startDate);",
          "  const date2 = new Date(value);",
          "  if (date1 > date2) {",
          "    alert('结束日期必须晚于开始日期');",
          "  }",
          "});"
        ].join("\n"),
        functionAudit: { matched: [], violations: [{ name: "alert" }] }
      }]
    }, {
      form: {
        fields: [
          { id: "fd_start", title: "开始", type: "date", componentId: "xform-date", props: {} },
          { id: "fd_end", title: "结束", type: "date", componentId: "xform-date", props: {} }
        ]
      }
    });

    const action = scripts.actions[0];
    assert.equal(action.event, "onChange");
    assert.equal(action.controlId, "fd_end");
    assert.equal(action.translationStatus, "needs_review");
    assert.notEqual(action.function, "");
    assert.equal(action.branchProvenance?.status, "unproven");
    assert.equal(action.coverage.status, "uncovered");
    assert.deepEqual(action.coverage.nativeRules, []);
    assert.equal(action.coverage.residuals.some((residual) =>
      residual.code === "script.residual.form_rule_condition_source_unproven"
    ), true);
    assert.equal(
      action.functionMappings.some((mapping) => mapping.basis === "legacy-runtime-noop"),
      false
    );
  });

  it("keeps computed-member calls review-required", () => {
    for (const call of ['window["alert"]("invalid")', 'vkor["eq"](0)']) {
      const scripts = draftMkScriptsFromSourceScripts({
        source: "sysform-jsp",
        sources: [{
          id: "computed-call.script.1",
          sourceRef: "source.form.jsp.computed-call.script.1",
          javascript: [
            "AttachXFormValueChangeEventById('fd_end', function(value){",
            "  var startDate = GetXFormFieldById('fd_start')[0].value;",
            "  if (new Date(startDate) > new Date(value)) {",
            `    ${call};`,
            "  }",
            "});"
          ].join("\n"),
          functionAudit: { matched: [], violations: [] }
        }]
      }, {
        form: {
          fields: [
            { id: "fd_start", title: "开始", type: "date", componentId: "xform-date", props: {} },
            { id: "fd_end", title: "结束", type: "date", componentId: "xform-date", props: {} }
          ]
        }
      });

      assert.equal(scripts.actions[0].translationStatus, "needs_review", call);
      assert.equal(scripts.actions[0].functionMappings.some((mapping) =>
        mapping.basis === "legacy-runtime-noop"
      ), false, call);
    }
  });

  it("deterministically maps a complete numeric compare onChange alert", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [{
        id: "negative-check.script.1",
        sourceRef: "source.form.jsp.negative-check.script.1",
        javascript: [
          "AttachXFormValueChangeEventById('fd_amount', function(value, domElement){",
          "  if (value < 0){",
          "    alert('金额不得小于0');",
          "  }",
          "});"
        ].join("\n"),
        functionAudit: { matched: [], violations: [{ name: "alert" }] }
      }]
    }, {
      form: {
        fields: [
          { id: "fd_amount", title: "金额", type: "number", componentId: "xform-input-number", props: {} }
        ]
      }
    });

    const action = scripts.actions[0];
    assert.equal(action.translationStatus, "mapped");
    assert.equal(action.deterministicBranchProof?.basis, "deterministic-synchronous-onchange-alert");
    assert.deepEqual(action.coverage, { status: "translated", nativeRules: [], residuals: [] });
    assert.match(action.function, /if \(value < 0\)/);
    assert.match(action.function, /MKXFORM\.toast\("金额不得小于0"\)/);

    const messages = [];
    const onChange = Function("MKXFORM", `${action.function}; return onChange;`)({
      toast(message) { messages.push(message); }
    });
    onChange(-1);
    onChange(0);
    assert.deepEqual(messages, ["金额不得小于0"]);
  });

  it("keeps unproven legacy row effects reviewable instead of declaring them no-ops", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [{
        id: "row-effect.script.1",
        sourceRef: "source.form.jsp.row-effect.script.1",
        javascript: [
          "Com_AddEventListener(window, 'load', function(){",
          "  if (legacyFlag === 1) {",
          "    common_dom_row_set_show_required_reset('fd_detail_row', true, true, false);",
          "  }",
          "});"
        ].join("\n"),
        functionAudit: { matched: [], violations: [] }
      }]
    }, {
      form: {
        fields: [
          { id: "fd_detail", title: "明细", type: "text", componentId: "xform-input", props: {} }
        ]
      }
    });

    const action = scripts.actions[0];
    assert.equal(action.event, "onLoad");
    assert.equal(action.branchProvenance?.status, "unproven");
    assert.equal(action.translationStatus, "needs_review");
    assert.equal(action.coverage.status, "uncovered");
    assert.equal(
      action.functionMappings.some((mapping) => mapping.basis === "legacy-runtime-noop"),
      false
    );
  });
});
