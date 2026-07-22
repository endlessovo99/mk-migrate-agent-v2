import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compileNativeFormRuleFormula,
  inspectNativeFormRuleProjection
} from "../../src/dsl/native-form-rule-projection.js";
import {
  buildConditionOperandResolver,
  parseProvenanceCondition
} from "../../src/dsl/script-condition-provenance.js";

describe("native form-rule formula projection", () => {
  it("preserves statically proven array-first, defaulting, and String derivations", () => {
    const rule = projectedRule({
      when: [{ field: "fd_trigger", op: "contains", value: "A" }],
      semantics: [{
        origin: "event:value",
        transforms: ["array-first", "default-empty", "string"],
        predicate: "indexOf"
      }]
    });
    const formula = compileNativeFormRuleFormula(rule);

    assert.match(formula.script, /Array\.isArray\(\$\{data\.biz\.fd_trigger\}\)/);
    assert.match(formula.script, /String\(\(.*\|\| \"\"\)\)/);
    assert.match(formula.script, /\.indexOf\(\"A\"\) >= 0/);
    assert.deepEqual(formula.varIds, ["fd_trigger"]);
  });

  it("keeps nullish defaulting and loose numeric equality semantically distinct", () => {
    const rule = projectedRule({
      when: [{ field: "fd_trigger", op: "eq", value: "0" }],
      semantics: [{
        origin: "event:value",
        transforms: ["nullish-empty", "string"],
        predicate: "loose-numeric-equality"
      }]
    });
    const formula = compileNativeFormRuleFormula(rule);

    assert.match(formula.script, /== null \? \"\"/);
    assert.match(formula.script, /String\(/);
    assert.match(formula.script, / == 0/);
    assert.doesNotMatch(formula.script, / === 0/);
  });

  it("rejects condition semantics that do not match the DSL clause", () => {
    const wrongPredicate = projectedRule({
      when: [{ field: "fd_trigger", op: "eq", value: "A" }],
      semantics: [{ origin: "event:value", transforms: [], predicate: "indexOf" }]
    });
    const incompleteRegexSet = projectedRule({
      logic: "or",
      when: [{ field: "fd_trigger", op: "eq", value: "A" }],
      semantics: [{
        origin: "event:value",
        transforms: [],
        predicate: "regex-char-set",
        pattern: "[AB]"
      }]
    });

    assert.equal(inspectNativeFormRuleProjection(wrongPredicate).ok, false);
    assert.equal(
      inspectNativeFormRuleProjection(wrongPredicate).issues.includes("condition_semantics_clause_mismatch"),
      true
    );
    assert.equal(inspectNativeFormRuleProjection(incompleteRegexSet).ok, false);
    assert.equal(
      inspectNativeFormRuleProjection(incompleteRegexSet).issues.includes("condition_semantics_regex_set_mismatch"),
      true
    );
  });

  it("accepts only complete static legacy field reads as condition provenance", () => {
    const exact = [
      "function onLoad() {",
      `  const selected = $('[name="extendDataFormInfo.value(fd_source)"]:checked').val()`,
      "  if (selected === 'A') return",
      "}"
    ].join("\n");
    const exactConditionIndex = exact.indexOf("selected ===");
    const exactCondition = parseProvenanceCondition(
      "selected === 'A'",
      buildConditionOperandResolver(exact),
      { beforeIndex: exactConditionIndex }
    );

    assert.equal(exactCondition?.operand, "field:fd_source");
    assert.equal(exactCondition?.value, "A");

    for (const [label, source, expression] of [
      [
        "mixed expression",
        [
          "function onLoad() {",
          `  const selected = MKXFORM.getValue('fd_other') + '[name="extendDataFormInfo.value(fd_source)"]:checked'`,
          "  if (selected === 'A') return",
          "}"
        ].join("\n"),
        "selected === 'A'"
      ],
      [
        "dynamic field id",
        [
          "function onLoad(suffix) {",
          "  const selected = MKXFORM.getValue(`fd_${suffix}`)",
          "  if (selected === 'A') return",
          "}"
        ].join("\n"),
        "selected === 'A'"
      ],
      [
        "dynamic comparison literal",
        [
          "function onLoad() {",
          "  const selected = MKXFORM.getValue('fd_source')",
          "  if (selected === `A${suffix}`) return",
          "}"
        ].join("\n"),
        "selected === `A${suffix}`"
      ]
    ]) {
      const beforeIndex = source.indexOf(expression);
      assert.equal(
        parseProvenanceCondition(
          expression,
          buildConditionOperandResolver(source),
          { beforeIndex }
        ),
        undefined,
        label
      );
    }
  });

  it("rejects onChange and onLoad operands backed only by nested or conditional decoy declarations", () => {
    for (const [label, source, expression] of [
      [
        "onChange nested function decoy",
        [
          "function onChange(value) {",
          "  function decoy() { var selected = value; }",
          "  if (selected.indexOf('A') >= 0) return",
          "}"
        ].join("\n"),
        "selected.indexOf('A') >= 0"
      ],
      [
        "onChange conditional initializer",
        [
          "function onChange(value) {",
          "  if (isReady) { var selected = value; }",
          "  if (selected.indexOf('A') >= 0) return",
          "}"
        ].join("\n"),
        "selected.indexOf('A') >= 0"
      ],
      [
        "onLoad nested function decoy",
        [
          "function onLoad() {",
          "  function decoy() { var selected = MKXFORM.getValue('fd_source'); }",
          "  if (selected === 'A') return",
          "}"
        ].join("\n"),
        "selected === 'A'"
      ],
      [
        "onLoad conditional initializer",
        [
          "function onLoad() {",
          "  if (isReady) { var selected = MKXFORM.getValue('fd_source'); }",
          "  if (selected === 'A') return",
          "}"
        ].join("\n"),
        "selected === 'A'"
      ]
    ]) {
      assert.equal(conditionFromSource(source, expression), undefined, label);
    }
  });

  it("keeps outer onChange and onLoad derivations visible in nested functions without crossing shadows", () => {
    const onChange = [
      "function onChange(value) {",
      "  const selected = value",
      "  function inspect() {",
      "    if (String(selected || '').indexOf('A') >= 0) return",
      "  }",
      "}"
    ].join("\n");
    const onLoad = [
      "function onLoad() {",
      "  const selected = MKXFORM.getValue('fd_source')",
      "  function inspect() {",
      "    if (selected === 'A') return",
      "  }",
      "}"
    ].join("\n");

    assert.deepEqual(
      conditionFromSource(onChange, "String(selected || '').indexOf('A') >= 0"),
      {
        kind: "contains",
        value: "A",
        operand: "event:value",
        transforms: ["default-empty", "string"],
        predicate: "indexOf"
      }
    );
    assert.equal(
      conditionFromSource(onLoad, "selected === 'A'")?.operand,
      "field:fd_source"
    );

    for (const [label, source, expression] of [
      [
        "onChange parameter shadow",
        onChange.replace("function inspect()", "function inspect(selected)"),
        "String(selected || '').indexOf('A') >= 0"
      ],
      [
        "onLoad parameter shadow",
        onLoad.replace("function inspect()", "function inspect(selected)"),
        "selected === 'A'"
      ]
    ]) {
      assert.equal(conditionFromSource(source, expression), undefined, label);
    }
  });

  it("rejects provenance aliases written through any other function scope", () => {
    for (const [label, source, expression] of [
      [
        "onChange nested mutation after initialization",
        [
          "function onChange(value) {",
          "  var selected = value",
          "  function mutate() { selected = MKXFORM.getValue('fd_other') }",
          "  mutate()",
          "  if (selected.indexOf('A') >= 0) return",
          "}"
        ].join("\n"),
        "selected.indexOf('A') >= 0"
      ],
      [
        "onLoad sibling mutation before initialization in source order",
        [
          "function onLoad() {",
          "  function mutate() { selected = MKXFORM.getValue('fd_other') }",
          "  var selected = MKXFORM.getValue('fd_source')",
          "  function inspect() {",
          "    if (selected === 'A') return",
          "  }",
          "}"
        ].join("\n"),
        "selected === 'A'"
      ]
    ]) {
      assert.equal(conditionFromSource(source, expression), undefined, label);
    }
  });
});

function conditionFromSource(source, expression) {
  return parseProvenanceCondition(
    expression,
    buildConditionOperandResolver(source),
    { beforeIndex: source.lastIndexOf(expression) }
  );
}

function projectedRule({ when, semantics, logic = "and" }) {
  return {
    id: "linkage.fd_trigger.test",
    trigger: "change",
    source: "fd_trigger",
    logic,
    when,
    effects: [{ type: "visible", target: "row_a", value: true }],
    else: [{ type: "visible", target: "row_a", value: false }],
    translationStatus: "executable",
    meta: {
      sourceJsp: "source.form.jsp.projection",
      sourceActionKey: "source.form.jsp.projection#onChange@0",
      displayGate: "xform:editShow",
      runWhen: { viewStatusIn: ["add", "edit"] },
      conditionSource: "event:value",
      nativeProjection: { kind: "view-status-formula", version: 1 },
      conditionSemantics: semantics
    }
  };
}
