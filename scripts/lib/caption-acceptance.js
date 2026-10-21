import { renderNativeCaption } from "../../tests/helpers/native-caption-renderer.js";
import { renderNativeFieldReferences } from "../../tests/helpers/native-form-renderer.js";

/** Expectations are supplied by an independently reviewed, hash-bound ledger.
 * This auditor deliberately does not import the translator or infer expected
 * merges from foldedCaption or review.captionFolding. */
export function auditCaptionAcceptance(ledger, draft, native, inputs) {
  if (!ledger) return { assessed: false, status: "not-assessed", required: null, actual: null, exceptions: null, remaining: null };
  const issues = [], results = [];
  if (!Array.isArray(ledger.relations) || !ledger.relations.length) throw new Error("Caption acceptance ledger has no reviewed relations");
  for (const relation of ledger.relations) {
    if (!["merge", "exception", "needs-evidence"].includes(relation.expectation) ||
        typeof relation.sourceRef !== "string" || !relation.sourceRef ||
        typeof relation.fieldId !== "string" || !relation.fieldId ||
        !Array.isArray(relation.captionIds) || !relation.captionIds.length ||
        relation.captionIds.some(id => typeof id !== "string" || !id) ||
        typeof relation.title !== "string" || !relation.title.trim() ||
        typeof relation.basis !== "string" || !relation.basis.trim()) {
      throw new Error(`Invalid reviewed caption expectation: ${relation.fieldId || "unknown"}`);
    }
  }
  for (const expected of ledger.inputs || []) {
    if (!inputs.some(input => input.path === expected.path && input.sha256 === expected.sha256)) issues.push({ reason: "expectation_input_hash_mismatch", path: expected.path });
  }
  if ((ledger.inputs || []).length !== inputs.length) issues.push({ reason: "expectation_input_inventory_mismatch" });
  const actualDecisions = draft.review?.captionFolding?.decisions || [];
  const key = entry => `${entry.sourceRef}:${entry.captionIds.join(",")}`;
  const expectedKeys = ledger.relations.map(key);
  if (new Set(expectedKeys).size !== expectedKeys.length ||
      actualDecisions.some(entry => !expectedKeys.includes(key(entry))) ||
      ledger.relations.some(entry => !actualDecisions.some(actual => key(actual) === key(entry)))) issues.push({ reason: "expectation_relation_inventory_mismatch" });
  const nativeFields = native?.dataModel.flatMap(model => model.fdFields || []) || [];
  const rendered = native && Object.fromEntries(["desktop", "mobile"].map(scene => [scene, renderNativeFieldReferences(native, scene).actual]));
  for (const expected of ledger.relations) {
    const owners = draft.form.fields.filter(field => field.sourceRef === expected.sourceRef);
    const owner = owners[0], captionId = expected.captionIds[0];
    const folded = owners.length === 1 && owner.sourceProps?.foldedCaption?.id === captionId;
    const decision = actualDecisions.find(entry => key(entry) === key(expected));
    const row = { ...expected, actual: folded ? "merged" : "separate", reason: decision?.reason, impact: decision?.evidence };
    results.push(row);
    if (expected.expectation !== "merge") {
      if (folded) issues.push({ reason: "unreviewed_or_exception_fold", fieldId: expected.fieldId });
      continue;
    }
    if (!folded) continue;
    const formerIds = [...expected.captionIds, owner.sourceProps.foldedCaption.referenceMap?.formerControlId].filter(Boolean);
    row.nativeProof = { fieldId: owner.id, formerIds,
      fieldCount: nativeFields.filter(field => field.fdName === owner.id).length,
      formerControlCount: nativeFields.filter(field => formerIds.includes(field.fdName)).length,
      scenes: {} };
    const fail = reason => issues.push({ reason, fieldId: expected.fieldId, captionId });
    if (owner.title !== expected.title || owner.props?.hiddenLabel === true) fail("expected_native_title_mismatch");
    if (draft.form.fields.some(field => expected.captionIds.includes(field.id) || expected.captionIds.includes(field.sourceProps?.originalId))) fail("source_label_not_removed");
    if (nativeFields.filter(field => field.fdName === owner.id).length !== 1 ||
        nativeFields.some(field => formerIds.includes(field.fdName))) { fail("native_control_not_unique"); continue; }
    const attribute = JSON.parse(nativeFields.find(field => field.fdName === owner.id).fdAttribute);
    for (const scene of ["desktop", "mobile"]) {
      if (rendered[scene].filter(id => id === owner.id).length !== 1 || rendered[scene].some(id => formerIds.includes(id))) fail(`native_${scene}_layout_not_unique`);
      const label = { ...attribute.config.labelProps, ...attribute.config.labelProps[scene] };
      const control = { ...attribute.config.controlProps, ...attribute.config.controlProps[scene] };
      if (label.hiddenLabel || control.hiddenLabel || label.hidden || control.hidden || label.visible === false || control.visible === false) fail(`native_${scene}_title_hidden`);
      const replay = renderNativeCaption(attribute, scene);
      row.nativeProof.scenes[scene] = { controlCount: rendered[scene].filter(id => id === owner.id).length,
        formerControlCount: rendered[scene].filter(id => formerIds.includes(id)).length, labels: replay.labels,
        titleVisible: !(label.hiddenLabel || control.hiddenLabel || label.hidden || control.hidden || label.visible === false || control.visible === false) };
      if (replay.labels.length !== 1 || replay.labels[0] !== expected.title) fail(`native_${scene}_title_not_rendered`);
    }
  }
  const required = results.filter(row => row.expectation === "merge").length;
  const actual = results.filter(row => row.expectation === "merge" && row.actual === "merged").length;
  const exceptions = results.filter(row => row.expectation === "exception").length;
  const needsEvidence = results.filter(row => row.expectation === "needs-evidence").length;
  return { assessed: true, status: issues.length ? "failed" : actual === required && !needsEvidence ? "complete" : "incomplete",
    required, actual, exceptions, needsEvidence, remaining: required - actual + needsEvidence, issues, relations: results };
}
