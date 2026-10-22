import assert from "node:assert/strict";
import { it } from "node:test";
import { sourceCaptionRelations } from "../../src/translator/source-caption-relations.js";
import { foldNativeCaptions } from "../../src/translator/native-caption-fold.js";

function sourceForm({ permission = false } = {}) {
  const caption = {
    id: "cap", sourceRef: "source.form.control.cap", title: "用印主体--子公司", sourceType: "description",
    sourceProps: {
      staticCaptionFact: { plainText: true, unique: true, unguarded: true, content: "用印主体--子公司", runtimePresent: true },
      captionStructureIssue: { reason: "source_binding_or_ancestry_unproven" },
      ...(permission ? { rightContainer: { id: "caption-right" } } : {})
    }
  };
  const owner = {
    id: "field", sourceRef: "source.form.control.field", title: "用印主体--子公司", sourceType: "select",
    sourceProps: {
      designerValues: { _label_bind: "false", _label_bind_id: "stale" },
      ...(permission ? { rightContainer: { id: "field-right" } } : {})
    }
  };
  return {
    controls: [caption, owner],
    layout: { rows: [{ sourceRef: "row", cells: [
      { sourceRef: "left", column: 0, colspan: 1, references: [{ referenceId: "cap" }] },
      { sourceRef: "right", column: 1, colspan: 1, references: [{ referenceId: "field" }] }
    ] }] }
  };
}

function dslForm() {
  return {
    fields: [
      { id: "cap", sourceRef: "source.form.control.cap", title: "用印主体--子公司", type: "description", componentId: "xform-description", props: { content: "用印主体--子公司" }, sourceProps: {} },
      { id: "field", sourceRef: "source.form.control.field", title: "用印主体--子公司", type: "singleSelect", componentId: "xform-select", props: {}, sourceProps: {} }
    ],
    layout: { mkTree: [{ sourceRef: "row", children: [
      { sourceRef: "left", column: 0, colspan: 1, refIds: ["cap"] },
      { sourceRef: "right", column: 1, colspan: 1, refIds: ["field"] }
    ] }] }
  };
}

it("folds an adjacent rendered title even when the exported bind points elsewhere", () => {
  const form = sourceForm();
  form.captionRelations = sourceCaptionRelations(form);
  assert.equal(form.captionRelations[0].disposition, "field-caption");
  assert.deepEqual(form.captionRelations[0].captionIds, ["cap"]);
  const draft = foldNativeCaptions(dslForm(), { form, scripts: { sources: [] } }, {
    behavior: { forPair: () => ({ ok: true, evidence: { proofMode: "test" } }) }
  });
  assert.equal(draft.fields.some(field => field.id === "cap"), false);
  const field = draft.fields.find(item => item.id === "field");
  assert.equal(field.title, "用印主体--子公司");
  assert.equal(field.props.hiddenLabel, undefined);
  assert.equal(field.sourceProps.foldedCaption.id, "cap");
});

it("keeps a separate permission caption and hides the repeated native title", () => {
  const form = sourceForm({ permission: true });
  form.captionRelations = sourceCaptionRelations(form);
  assert.equal(form.captionRelations[0].disposition, "exception");
  assert.equal(form.captionRelations[0].reason, "independent_permission");
  const draft = foldNativeCaptions(dslForm(), { form, scripts: { sources: [] } });
  assert.equal(draft.fields.some(field => field.id === "cap"), true);
  assert.equal(draft.fields.find(field => field.id === "field").props.hiddenLabel, true);
});
