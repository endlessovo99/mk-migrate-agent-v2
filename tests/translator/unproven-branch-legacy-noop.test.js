import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftMkScriptsFromSourceScripts } from "../../src/translator/sysform-jsp-scripts.js";

describe("unproven branch draft closure", () => {
  it("omits unproven onChange branches with legacy-runtime-noop instead of leaving needs_review", () => {
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
    assert.equal(action.translationStatus, "omitted");
    assert.equal(action.function, "");
    assert.equal(action.branchProvenance?.status, "unproven");
    assert.deepEqual(action.coverage, { status: "covered", nativeRules: [], residuals: [] });
    assert.equal(
      action.functionMappings.some((mapping) => mapping.basis === "legacy-runtime-noop"),
      true
    );
  });

  it("keeps proven numeric compare onChange actions reviewable for agent mapping", () => {
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
    assert.equal(action.translationStatus, "needs_review");
    assert.equal(action.branchProvenance.status, "proven");
    assert.deepEqual(action.branchProvenance.conditions, [{
      kind: "lt",
      value: "0",
      origin: "event:value",
      transforms: [],
      predicate: "numeric-<"
    }]);
  });
});
