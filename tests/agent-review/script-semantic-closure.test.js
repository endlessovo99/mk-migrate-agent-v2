import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  validateAssignmentBranchSemantics,
  validateRowMarkerBranchSemantics
} from "../../src/agent-review/script-semantic-closure.js";

const sourceRef = "source.form.jsp.regex-set";
const targetFieldId = "fd_helper";
const rowMarker = "fd_regex_row";

describe("Agent Review regex-set semantic closure", () => {
  it("accepts an exact regex-set assignment branch", () => {
    const result = validateAssignmentBranchSemantics({
      sourceFunction: generatedSourceFunction([
        "AttachXFormValueChangeEventById('fd_subject', function(value) {",
        `  var helper = GetXFormFieldById('${targetFieldId}')[0]`,
        "  if (/[OL]/.test(value)) {",
        "    helper.value = 'matched'",
        "  } else {",
        "    helper.value = ''",
        "  }",
        "})"
      ]),
      reviewedFunction: reviewedAssignmentFunction("[OL]"),
      residuals: assignmentResiduals()
    });

    assert.deepEqual(result, { ok: true });
  });

  it("rejects a changed or dynamic regex-set assignment branch", () => {
    for (const [label, reviewedFunction, expectedReason] of [
      ["changed set", reviewedAssignmentFunction("[O]"), "condition_chain_changed"],
      ["dynamic regex", reviewedDynamicRegexAssignmentFunction(), "condition_not_statically_supported"]
    ]) {
      const result = validateAssignmentBranchSemantics({
        sourceFunction: generatedSourceFunction([
          "AttachXFormValueChangeEventById('fd_subject', function(value) {",
          `  var helper = GetXFormFieldById('${targetFieldId}')[0]`,
          "  if (/[OL]/.test(value)) {",
          "    helper.value = 'matched'",
          "  } else {",
          "    helper.value = ''",
          "  }",
          "})"
        ]),
        reviewedFunction,
        residuals: assignmentResiduals()
      });

      assert.equal(result.ok, false, label);
      assert.equal(result.reason, expectedReason, label);
    }
  });

  it("accepts an exact regex-set row-state branch", () => {
    const result = validateRowMarkerBranchSemantics({
      sourceFunction: generatedSourceFunction([
        "AttachXFormValueChangeEventById('fd_subject', function(value) {",
        "  if (/[OL]/.test(value)) {",
        `    common_dom_row_set_show_required_reset('${rowMarker}', true, false, false)`,
        "  } else {",
        `    common_dom_row_set_show_required_reset('${rowMarker}', false, false, false)`,
        "  }",
        "})"
      ]),
      reviewedFunction: reviewedRowFunction("[OL]"),
      resolvedMarkers: [rowMarker],
      primaryMarkerByAlias: new Map()
    });

    assert.deepEqual(result, { ok: true });
  });

  it("rejects a changed regex-set row-state branch", () => {
    const result = validateRowMarkerBranchSemantics({
      sourceFunction: generatedSourceFunction([
        "AttachXFormValueChangeEventById('fd_subject', function(value) {",
        "  if (/[OL]/.test(value)) {",
        `    common_dom_row_set_show_required_reset('${rowMarker}', true, false, false)`,
        "  } else {",
        `    common_dom_row_set_show_required_reset('${rowMarker}', false, false, false)`,
        "  }",
        "})"
      ]),
      reviewedFunction: reviewedRowFunction("[O]"),
      resolvedMarkers: [rowMarker],
      primaryMarkerByAlias: new Map()
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "row_control_flow_unverified");
    assert.equal(result.conditionalReason, "target_row_condition_chain_changed");
  });
});

function generatedSourceFunction(lines) {
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    "  // Source JSP JavaScript:",
    ...lines.map((line) => `  // ${line}`),
    "}"
  ].join("\n");
}

function reviewedAssignmentFunction(pattern) {
  return [
    "function onChange(value) {",
    `  if (/${pattern}/.test(value)) {`,
    `    MKXFORM.setValue('${targetFieldId}', 'matched')`,
    "  } else {",
    `    MKXFORM.setValue('${targetFieldId}', '')`,
    "  }",
    "}"
  ].join("\n");
}

function reviewedDynamicRegexAssignmentFunction() {
  return [
    "function onChange(value) {",
    "  var matcher = new RegExp('[OL]')",
    "  if (matcher.test(value)) {",
    `    MKXFORM.setValue('${targetFieldId}', 'matched')`,
    "  } else {",
    `    MKXFORM.setValue('${targetFieldId}', '')`,
    "  }",
    "}"
  ].join("\n");
}

function reviewedRowFunction(pattern) {
  return [
    "function onChange(value) {",
    `  if (/${pattern}/.test(value)) {`,
    `    MKXFORM.setFieldAttr('${rowMarker}', 5)`,
    `    MKXFORM.setFieldAttr('${rowMarker}', 6)`,
    "  } else {",
    `    MKXFORM.setFieldAttr('${rowMarker}', 4)`,
    `    MKXFORM.setFieldAttr('${rowMarker}', 6)`,
    "  }",
    "}"
  ].join("\n");
}

function assignmentResiduals() {
  return [
    {
      code: "script.residual.field_value_assignment",
      sourceRef,
      target: targetFieldId,
      evidence: "helper.value = 'matched'"
    },
    {
      code: "script.residual.field_value_assignment",
      sourceRef,
      target: targetFieldId,
      evidence: "helper.value = ''"
    }
  ];
}
