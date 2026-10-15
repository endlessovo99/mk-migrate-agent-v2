import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { validateAssignmentBranchSemantics } from "../../src/agent-review/script-semantic-closure.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { reviewEventValueAssignment } from "./fake-review-scenarios/event-value-assignment.js";
import { runRouteCase } from "./run-route-case.js";

const fixtureRoot = "tests/fixtures/route-validation/event-value-assignment";

describe("event-value assignment Route-validation", () => {
  for (const shape of ["prefix", "else"]) {
    it(`preserves every ${shape} write through review, trust, dry-run and fake readback`, async () => {
      const result = await runRouteCase(`event-value-assignment-${shape}-success`);
      assert.equal(result.dsl.trust.executable, true);
      assert.equal(result.dryRun.ok, true);
      assert.equal(result.execution.readback.ok, true);
      const writes = [];
      const attributes = [];
      const api = {
        setValue(target, value) { writes.push([target, value]); },
        setFieldAttr(target, attribute) { attributes.push([target, attribute]); }
      };
      const action = result.dsl.scripts.actions[0];
      assert.equal(action.translationStatus, "mapped");
      const invoke = new Function("MKXFORM", `${action.function}; return onChange;`)(api);
      for (const value of ["A", "B", "", "A"]) {
        writes.length = 0;
        attributes.length = 0;
        invoke(value);
        assert.deepEqual(writes, shape === "prefix" && value !== "A"
          ? [["fd_copy", value], ["fd_clear", []]]
          : shape === "else" && value === "A"
          ? [["fd_copy", "first"], ["fd_copy", "A"]]
          : [["fd_copy", value]]);
        if (shape === "prefix") {
          assert.deepEqual(attributes, []);
          assert.deepEqual(action.coverage.nativeRules, ["linkage.fd_trigger.contains.A"]);
        }
      }
    });
  }

  it("rejects conditional, reordered, cleared, or wrong-target event copies", () => {
    const copy = 'MKXFORM.setValue("fd_copy", value);';
    for (const [label, transform] of [
      ["conditional", (text) => text.replace(copy, `if (value.indexOf("A") >= 0) { ${copy} }`)],
      ["moved after branches", (text) => text.replace(copy, "").replace(/\n}$/, `\n${copy}\n}`)],
      ["wrong existing target", (text) => text.replace(copy, 'MKXFORM.setValue("fd_dependent", value);')],
      ["source-free clear", (text) => text.replace(copy, 'MKXFORM.setValue("fd_copy", "");')],
      ["extra source-free write", (text) => text.replace(copy, `${copy} MKXFORM.setValue("fd_dependent", "");`)],
      ["missing choice clear", (text) => text.replace('MKXFORM.setValue("fd_clear", []);', "")],
      ["duplicate choice clear", (text) => text.replace('MKXFORM.setValue("fd_clear", []);', 'MKXFORM.setValue("fd_clear", []); MKXFORM.setValue("fd_clear", []);')],
      ["wrong choice empty value", (text) => text.replace('"fd_clear", []', '"fd_clear", ""')],
      ["unconditional choice clear", (text) => text.replace('MKXFORM.setValue("fd_clear", []);', "").replace(copy, `${copy} MKXFORM.setValue("fd_clear", []);`)]
    ]) {
      assert.equal(patchResult("prefix", transform).ok, false, label);
    }
  });

  it("rejects dropping the native row-rule evidence while closing the residual script", () => {
    const sourceDraft = cleanSourceFile(`${fixtureRoot}/event-prefix_SysFormTemplate.xml`);
    const dslDraft = draftSourceDraft(sourceDraft);
    const response = reviewEventValueAssignment({ dslDraft });
    const patches = response.patches.map((patch) => patch.path.endsWith("/coverage")
      ? { ...patch, value: { ...patch.value, nativeRules: [] } } : patch);
    assert.equal(applyEvidenceBackedPatches(dslDraft, patches, {
      sourceRefs: collectSourceRefs(sourceDraft), sourceDraft
    }).ok, false);
  });

  it("requires the exact paired selectors, the checkbox type, and the original clear branch", () => {
    const sourceDraft = cleanSourceFile(`${fixtureRoot}/event-prefix_SysFormTemplate.xml`);
    const dslDraft = draftSourceDraft(sourceDraft);
    const action = dslDraft.scripts.actions[0];
    const reviewed = reviewEventValueAssignment({ dslDraft }).patches.find((patch) => patch.path.endsWith("/function")).value;
    const proof = (sourceFunction, form = dslDraft.form) => validateAssignmentBranchSemantics({
      sourceFunction, reviewedFunction: reviewed, form,
      residuals: action.coverage.residuals.filter((residual) => residual.code === "script.residual.field_value_assignment")
    });
    assert.equal(proof(action.function).ok, true);
    assert.equal(proof(action.function, { fields: [] }).ok, false);
    assert.equal(proof(action.function, { ...dslDraft.form, fields: dslDraft.form.fields.map((field) => field.id === "fd_clear"
      ? { ...field, componentId: "xform-radio" } : field) }).ok, false);
    assert.equal(proof(action.function.replace('_extendDataFormInfo.value(fd_clear)', '_extendDataFormInfo.value(fd_unrelated)')).ok, false);
    assert.equal(proof(action.function.replace('.prop("checked", false)', '.prop("disabled", false)')).ok, false);
    assert.equal(proof(action.function.replace('input[name="extendDataFormInfo.value(fd_clear)"]', '#fd_clear')).ok, false);
  });

  it("rejects computed setters, API escape, and writes hidden in callable scopes", () => {
    for (const [label, extra] of [
      ["computed setter", 'MKXFORM["setValue"]("fd_copy", "unexpected");'],
      ["computed clear", 'MKXFORM["setValue"]("fd_clear", []);'],
      ["method alias", 'var write = MKXFORM.setValue; write("fd_copy", "unexpected");'],
      ["API alias", 'var api = MKXFORM; api.setValue("fd_copy", "unexpected");'],
      ["destructured method", 'var { setValue: write } = MKXFORM; write("fd_copy", "unexpected");'],
      ["method call", 'MKXFORM.setValue.call(null, "fd_copy", "unexpected");'],
      ["parenthesized setter", '(MKXFORM.setValue)("fd_copy", "unexpected");'],
      ["nested same-target write", 'function write(){ MKXFORM.setValue("fd_copy", "unexpected"); } write();'],
      ["nested computed write", 'function write(){ MKXFORM["setValue"]("fd_copy", "unexpected"); } write();'],
      ["ambient object alias", 'var api = this; api.setValue("fd_copy", "unexpected");'],
      ["global object escape", 'var host = globalThis; var key = "MK" + "XFORM"; host[key]["setValue"]("fd_copy", "unexpected");'],
      ["global API alias", 'var api = globalThis["MKXFORM"]; api.setValue("fd_copy", "unexpected");']
    ]) {
      assert.equal(patchResult("prefix", (text) => text.replace(/\n}$/, `\n${extra}\n}`)).ok, false, label);
    }
    assert.equal(patchResult("prefix", (text) => text.replace(/\n}$/, '\nwrite();\n}') +
      '\nfunction write(){ MKXFORM.setValue("fd_copy", "unexpected"); }').ok, false);
  });

  it("rejects changed conditions, discarded intermediate writes, and a different event origin", () => {
    for (const [label, transform] of [
      ["changed branch", (text) => text.replace('indexOf("A")', 'indexOf("B")')],
      ["lost intermediate write", (text) => text.replace('MKXFORM.setValue("fd_copy", "first");', "")],
      ["different field value", (text) => text.replace('"fd_copy", value', '"fd_copy", MKXFORM.getValue("fd_trigger")')],
      ["event shadowed", (text) => text.replace('MKXFORM.setValue("fd_copy", value);', '{let value="changed"; MKXFORM.setValue("fd_copy",value);}')]
    ]) {
      assert.equal(patchResult("else", transform).ok, false, label);
    }
  });
});

function patchResult(shape, transform) {
  const sourceDraft = cleanSourceFile(`${fixtureRoot}/event-${shape}_SysFormTemplate.xml`);
  const dslDraft = draftSourceDraft(sourceDraft);
  const response = reviewEventValueAssignment({ dslDraft });
  const patches = response.patches.map((patch) => patch.path.endsWith("/function")
    ? { ...patch, value: transform(patch.value) }
    : patch);
  return applyEvidenceBackedPatches(dslDraft, patches, {
    sourceRefs: collectSourceRefs(sourceDraft), sourceDraft
  });
}
