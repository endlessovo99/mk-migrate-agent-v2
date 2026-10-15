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

  it("rejects an omitted source global assignment even when its branch has no row effect", () => {
    const result = validateRowMarkerBranchSemantics({
      sourceFunction: generatedSourceFunction([
        'var tempValue = GetXFormFieldById("fd_the_city_flag")[0].value;',
        'if (tempValue == "0") {',
        `  common_dom_row_set_show_required_reset("${rowMarker}", false, false, false);`,
        "} else {",
        "  theCityFlag = 1;",
        "}"
      ]),
      reviewedFunction: [
        "function onLoad() {",
        '  var tempValue = MKXFORM.getValue("fd_the_city_flag");',
        '  if (tempValue == "0") {',
        `    MKXFORM.setFieldAttr("${rowMarker}", 4);`,
        `    MKXFORM.setFieldAttr("${rowMarker}", 6);`,
        "  }",
        "}"
      ].join("\n"),
      resolvedMarkers: [rowMarker],
      primaryMarkerByAlias: new Map()
    });

    assert.deepEqual(result, { ok: false, reason: "row_ordered_effect_unproven" });
  });

  it("accepts an omitted source else only when it has no effect", () => {
    const result = validateRowMarkerBranchSemantics({
      sourceFunction: generatedSourceFunction([
        'var tempValue = GetXFormFieldById("fd_the_city_flag")[0].value;',
        'if (tempValue == "0") {',
        `  common_dom_row_set_show_required_reset("${rowMarker}", false, false, false);`,
        "} else {",
        "}"
      ]),
      reviewedFunction: [
        "function onLoad() {",
        '  var tempValue = MKXFORM.getValue("fd_the_city_flag");',
        '  if (tempValue == "0") {',
        `    MKXFORM.setFieldAttr("${rowMarker}", 4);`,
        `    MKXFORM.setFieldAttr("${rowMarker}", 6);`,
        "  }",
        "}"
      ].join("\n"),
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

describe("Agent Review callback event assignment provenance", () => {
  it("preserves literal branches and an event-value else without dropping intermediate writes", () => {
    assert.deepEqual(eventAssignmentCheck("branch"), { ok: true });
  });

  it("preserves an unconditional event copy before the source condition chain", () => {
    assert.deepEqual(eventAssignmentCheck("prefix"), { ok: true });
  });

  it("rejects changes to assignment targets, values, branches, and write order", () => {
    for (const [label, edit] of [
      ["wrong target", (text) => text.replaceAll("fd_copy", "fd_wrong")],
      ["different field origin", (text) => text.replace('"fd_copy", value', '"fd_copy", MKXFORM.getValue("fd_other")')],
      ["transformed event", (text) => text.replace('"fd_copy", value', '"fd_copy", String(value)')],
      ["rebound event", (text) => text.replace("function onChange(value) {", 'function onChange(value) { value = "A";')],
      ["changed condition", (text) => text.replace('indexOf("A")', 'indexOf("B")')],
      ["lost intermediate write", (text) => text.replace('MKXFORM.setValue("fd_copy", "first");', "")],
      ["extra unrelated write", (text) => text.replace('MKXFORM.setValue("fd_copy", value);', 'MKXFORM.setValue("fd_copy", value); MKXFORM.setValue("fd_unrelated", []);')],
      ["swapped writes", (text) => text.replace('MKXFORM.setValue("fd_copy", "first");\n    MKXFORM.setValue("fd_copy", "A");', 'MKXFORM.setValue("fd_copy", "A");\n    MKXFORM.setValue("fd_copy", "first");')],
      ["shadowed event", (text) => text.replace('MKXFORM.setValue("fd_copy", value);', '{ let value = "shadow"; MKXFORM.setValue("fd_copy", value); }')]
    ]) {
      assert.equal(eventAssignmentCheck("branch", edit).ok, false, label);
    }
  });

  it("rejects moving a prefix write behind or inside a condition, loop, or nested function", () => {
    const call = 'MKXFORM.setValue("fd_copy", value);';
    for (const [label, edit] of [
      ["conditional copy", (text) => text.replace(call, `if (value.indexOf("A") >= 0) { ${call} }`)],
      ["postlude copy", (text) => text.replace(call, "").replace(/\n}$/, `\n  ${call}\n}`)],
      ["loop copy", (text) => text.replace(call, `for (let index = 0; index < 1; index++) { ${call} }`)],
      ["nested function", (text) => text.replace(call, `function copy() { ${call} } copy();`)],
      ["early return", (text) => text.replace(call, `if (value === "") return; ${call}`)]
    ]) {
      assert.equal(eventAssignmentCheck("prefix", edit).ok, false, label);
    }
  });

  it("does not accept a source RHS that is unbound or belongs to another callback", () => {
    for (const sourceEdit of [
      (text) => text.replaceAll("copy.value=value", "copy.value=unknownValue"),
      (text) => text.replace("function(value)", "function(otherValue)"),
      (text) => text.replace("copy.value=value;", 'copy = GetXFormFieldById("fd_other")[0]; copy.value=value;'),
      (text) => text.replace("copy.value=value;", 'value = "changed"; copy.value=value;')
    ]) {
      assert.equal(eventAssignmentCheck("prefix", (text) => text, sourceEdit).ok, false);
    }
  });
});

function eventAssignmentCheck(shape, targetEdit = (text) => text, sourceEdit = (text) => text) {
  const sourceLines = shape === "prefix" ? [
    'AttachXFormValueChangeEventById("fd_trigger", function(value) {',
    '  var copy = GetXFormFieldById("fd_copy")[0];',
    '  copy.value=value;',
    '  if (value.indexOf("A") >= 0) {',
    '    common_dom_row_set_show_required_reset("row_a",true,false,false);',
    '  } else if (value.indexOf("B") >= 0) {',
    '    common_dom_row_set_show_required_reset("row_b",true,false,false);',
    '  }',
    '});'
  ] : [
    'AttachXFormValueChangeEventById("fd_trigger", function(value) {',
    '  var copy = GetXFormFieldById("fd_copy")[0];',
    '  if (value.indexOf("A") >= 0) {',
    '    copy.value="first";',
    '    copy.value="A";',
    '  } else {',
    '    copy.value=value;',
    '  }',
    '});'
  ];
  const source = sourceEdit(sourceLines.join("\n"));
  const reviewed = shape === "prefix" ? [
    'function onChange(value) {',
    '  MKXFORM.setValue("fd_copy", value);',
    '  if (value.indexOf("A") >= 0) {',
    '    MKXFORM.setFieldAttr("row_a", 5);',
    '  } else if (value.indexOf("B") >= 0) {',
    '    MKXFORM.setFieldAttr("row_b", 5);',
    '  }',
    '}'
  ] : [
    'function onChange(value) {',
    '  if (value.indexOf("A") >= 0) {',
    '    MKXFORM.setValue("fd_copy", "first");',
    '    MKXFORM.setValue("fd_copy", "A");',
    '  } else {',
    '    MKXFORM.setValue("fd_copy", value);',
    '  }',
    '}'
  ];
  return validateAssignmentBranchSemantics({
    sourceFunction: generatedSourceFunction(source.split("\n")),
    reviewedFunction: targetEdit(reviewed.join("\n")),
    residuals: [...source.matchAll(/copy\.value\s*=\s*([^;]+);/g)].map((match) => ({
      code: "script.residual.field_value_assignment",
      target: "fd_copy",
      evidence: match[0].slice(0, -1)
    }))
  });
}
