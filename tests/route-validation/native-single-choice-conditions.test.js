import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig, formAttr } from "../helpers/persistence.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { nativeScalarFormRules } from "../helpers/native-scalar-form-rules.js";

const source = "tests/fixtures/source/149c6e78f7c015f4c7da952411fa0cef";
const drivers = ["fd_3ded07af4e64c6", "fd_3ded08386a01d2", "fd_3ded0898e10da4"];
const radios = ["fd_3ded0a9fdb98b0", "fd_3ded0aa24c895e", "fd_3ded0cb1f16c98", "fd_3ded0bdcf815d6",
  "fd_3ded0aadb6b850", "fd_3ded0aac8232a6", "fd_3ded0cfa2167e2", "fd_3ded0c43d91b6e", "fd_3df0cabd799870"];
const quality = () => {
  const draft = draftSourceDraft(cleanSourceFile(source));
  draft.workflow = null;
  return prepareSample(draft);
};

it("hides source conditional rows on native initialization with absent radio values", () => {
  const prepared = quality(), runtime = nativeScalarFormRules(xformConfig(prepared.update));
  runtime.initialize();
  assert.deepEqual(radios.filter(id => runtime.visible(id)), []);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("runs exact membership through native initialization and successive source branch changes", () => {
  const prepared = quality(), runtime = nativeScalarFormRules(xformConfig(prepared.update));
  runtime.initialize();
  for (const [selection, expected] of [
    [["zzqy", "zdzlsj", "ppyx"], ["fd_3ded0a9fdb98b0"]],
    [["zzqy", "zdzlsj", "xmyx"], ["fd_3ded0aa24c895e"]],
    [["gcqy", "zdzlsj", "xmyx"], ["fd_3ded0aa24c895e"]],
    [["zz", "zdzlsj", "xmyx"], []],
    [["gcqy", "zdzlsj", "jjyx"], ["fd_3ded0bdcf815d6"]],
    [["zzqy", "jdzlsj", "ppyx"], ["fd_3ded0aadb6b850"]],
    [["zzqy", "jdzlsj", "xmyx"], ["fd_3ded0aac8232a6"]],
    [["gcqy", "jdzlsj", "jjyx"], ["fd_3ded0c43d91b6e"]],
    [["gcqy", "jjzlsj", "jjyx"], ["fd_3df0cabd799870"]],
    [[undefined, undefined, undefined], []]
  ]) {
    drivers.forEach((id, index) => runtime.change(id, selection[index]));
    assert.deepEqual(radios.filter(id => runtime.visible(id)), expected, JSON.stringify(selection));
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});

function scalarRule({ componentId = "xform-radio", clauses, logic = "and", options = ["A", "AA", "null", "[]", "NaN", "0", "false"] } = {}) {
  return sampleTrustedDsl({ workflow: null, form: { fields: [
    { id: "choice", title: "Choice", type: componentId === "xform-radio" ? "radio" : "singleSelect", componentId,
      props: { options: options.map(value => ({ label: value, value })) } },
    { id: "other", title: "Other choice", type: "radio", componentId: "xform-radio", props: { options: [{ label: "B", value: "B" }, { label: "BB", value: "BB" }] } },
    { id: "target", title: "Conditional field", type: "text", componentId: "xform-input", props: { required: true } }
  ], layout: { mkTree: ["choice", "other", "target"].map((id, index) => ({
    id: `layout.row-${index}`, componentId: "xform-flex-1-1-layout", props: { columns: 1, sourceColumns: 1 },
    children: [{ id: `layout.cell-${index}`, refType: "field", refIds: [id], column: 0, colspan: 1 }]
  })) } }, formRules: { linkage: [{ id: "scalar-condition", trigger: "change", logic,
    when: clauses || [{ field: "choice", op: "eq", value: "A" }],
    effects: [{ type: "visible", target: "target", value: true }, { type: "required", target: "target", value: true }],
    else: [{ type: "visible", target: "target", value: false }, { type: "required", target: "target", value: false }],
    translationStatus: "executable" }] } });
}

it("keeps native equality and its complement disjoint for nonempty scalar choice literals and empty sentinels", () => {
  for (const componentId of ["xform-radio", "xform-select"]) for (const expected of ["A", "null", "[]", "NaN", "0", "false"]) {
    const prepared = prepareSample(scalarRule({ componentId, clauses: [{ field: "choice", op: "eq", value: expected }] }));
    const runtime = nativeScalarFormRules(xformConfig(prepared.update));
    for (const value of [undefined, null, "", [], NaN, 0, false, "A", "AA", "null", "[]", "NaN", "0", "false"]) {
      runtime.initialize({ choice: value });
      const expectedVisible = ![undefined, null, ""].includes(value) && !Array.isArray(value) && !Number.isNaN(value) && String(value) === expected;
      const flags = [...new Set(runtime.effects.filter(e => e.kind === "display").map(e => e.displayFlag))];
      assert.deepEqual(flags, [expectedVisible ? "display" : "hide"], `${componentId}: ${expected}, ${String(value)}`);
      assert.equal(runtime.visible("target"), expectedVisible);
      assert.equal(runtime.runtime.required("target"), expectedVisible);
    }
    assert.equal(prepared.verify(prepared.update).ok, true);
  }
});

it("retains grouping for AND, OR and omitted logic with exact in membership", () => {
  for (const logic of ["and", "or", undefined]) {
    const dsl = scalarRule({ logic, clauses: [
      { field: "choice", op: "in", value: ["A", "AA"] }, { field: "other", op: "eq", value: "B" }
    ] });
    if (logic === undefined) delete dsl.formRules.linkage[0].logic;
    const prepared = prepareSample(dsl), runtime = nativeScalarFormRules(xformConfig(prepared.update));
    for (const [choice, other, and, or] of [[undefined, undefined, false, false], ["A", undefined, false, true],
      [undefined, "B", false, true], ["A", "B", true, true], ["AA", "BB", false, true], ["AAA", "BB", false, false]]) {
      runtime.initialize({ choice, other });
      const expected = logic === "or" ? or : and;
      assert.deepEqual([...new Set(runtime.effects.filter(e => e.kind === "display").map(e => e.displayFlag))], [expected ? "display" : "hide"]);
    }
    assert.equal(prepared.verify(prepared.update).ok, true);
  }
});

it("matches every fixed enum member exactly instead of using substring membership", () => {
  const prepared = prepareSample(scalarRule({ clauses: [{ field: "choice", op: "in", value: ["A", "AA"] }] }));
  const runtime = nativeScalarFormRules(xformConfig(prepared.update));
  for (const value of [undefined, null, "", [], "A", "AA", "null", "[]", "NaN", "0", "false", "AAA", "A,AA"]) {
    runtime.initialize({ choice: value });
    const expected = value === "A" || value === "AA";
    assert.deepEqual([...new Set(runtime.effects.filter(e => e.kind === "display").map(e => e.displayFlag))], [expected ? "display" : "hide"]);
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("does not rewrite source ne, empty-string comparisons or non-scalar-choice domains", () => {
  for (const values of [
    { clauses: [{ field: "choice", op: "ne", value: "A" }] },
    { clauses: [{ field: "choice", op: "eq", value: "" }] },
    { clauses: [{ field: "choice", op: "eq", value: 0 }] },
    { clauses: [{ field: "choice", op: "eq", value: false }] },
    { componentId: "xform-checkbox" }
  ]) {
    const rules = formAttr(prepareSample(scalarRule(values)).update).formRule.display;
    assert.equal(rules.length, 2);
    assert.equal(rules[0].choices.items.length, 1);
    assert.equal(rules[1].choices.items.length, 1);
  }
});

it("keeps dynamic, free-text Other and detail-column choices outside the proved main scalar domain", () => {
  for (const change of [
    dsl => { dsl.form.fields[0].props.optionSource = "rule"; },
    dsl => { dsl.form.fields[0].props.options.push({ label: "Empty", value: "" }); },
    dsl => { dsl.form.fields[0].props.options.push({ label: "Other", value: "other_", type: "other" }); },
    dsl => {
      const column = dsl.form.fields.shift();
      dsl.form.fields.unshift({ id: "rows", title: "Rows", type: "detailTable", componentId: "xform-detail-table", columns: [column] });
      dsl.formRules.linkage[0].when[0].field = "rows.choice";
    }
  ]) {
    const dsl = scalarRule(); change(dsl);
    const rules = formAttr(prepareSample(dsl).update).formRule.display;
    assert.equal(rules.length, 2);
    assert.ok(rules.every(rule => rule.choices.items.length === 1));
  }
});

it("leaves a complete mixed rule on its existing route when any clause lacks the single-choice proof", () => {
  for (const clause of [
    { field: "other", op: "ne", value: "B" },
    { field: "other", op: "contains", value: "" },
    { field: "target", op: "eq", value: "A" }
  ]) {
    const dsl = scalarRule({ clauses: [{ field: "choice", op: "eq", value: "A" }, clause] });
    const rules = formAttr(prepareSample(dsl).update).formRule.display;
    assert.equal(rules.length, 2);
    assert.deepEqual(rules[0].choices.items.map(item => item.operate), ["=", clause.op === "ne" ? "!=" : clause.op === "contains" ? "include" : "="]);
    assert.ok(rules.every(rule => !rule.choices.items.some(item => item.operate === "notEmpty")));
  }
});

it("rejects readback that loses the positive empty guard or negative empty branch", () => {
  for (const side of ["positive", "negative"]) {
    const prepared = prepareSample(scalarRule()), template = structuredClone(prepared.update);
    const config = xformConfig(template), attribute = JSON.parse(config.attribute.formAttr);
    const rules = attribute.formRule.display;
    if (side === "positive") {
      const when = rules.find(rule => rule.meta.branch === "when");
      when.choices.items = when.choices.items.filter(item => item.operate !== "notEmpty");
    } else {
      const index = rules.findIndex(rule => rule.meta.branch === "else" && rule.choices.items.some(item => item.operate === "empty"));
      assert.ok(index >= 0);
      rules.splice(index, 1);
    }
    config.attribute.formAttr = JSON.stringify(attribute);
    template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    const result = prepared.verify(template);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(d => d.code === "readback.form_rules.semantic_missing"));
  }
});

it("bounds positive membership and negative complement DNF expansion", () => {
  for (const [logic, op] of [["and", "in"], ["or", "eq"]]) {
    const dsl = scalarRule();
    const field = dsl.form.fields[0];
    const ids = Array.from({ length: 6 }, (_, i) => `choice_${i}`);
    dsl.form.fields.push(...ids.map(id => ({ ...structuredClone(field), id })));
    Object.assign(dsl.formRules.linkage[0], { logic,
      when: ids.map(id => ({ field: id, op, value: op === "in" ? ["A", "AA"] : "A" })) });
    assert.throws(() => prepareSample(dsl), error => error.diagnostics?.some(d =>
      d.code === "projection.form_rule.single_choice_variants_exceeded"));
  }
});
