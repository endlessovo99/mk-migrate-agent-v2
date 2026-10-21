import { canonicalJson } from "../agent-review/digest.js";
import { nativeCaptionFoldIssues } from "../dsl/native-caption-fold.js";
import { draftSourceDraft } from "./dsl-draft.js";

/** Offline acceptance: rebuild the required folds and require an explicit
 * disposition for every candidate. This never promotes a DSL to trusted. */
export function auditCaptionFolding(source, actual) {
  const expected = draftSourceDraft(source);
  const report = expected.review?.captionFolding;
  const issues = [...nativeCaptionFoldIssues(expected.form, actual.form).issues];
  if (canonicalJson(report) !== canonicalJson(actual.review?.captionFolding)) {
    issues.push({ reason: "caption_decisions_mismatch" });
  }
  for (const decision of report?.decisions || []) {
    if (decision.status === "folded") continue;
    const priorOwner = expected.form.fields.find(field => field.sourceRef === decision.sourceRef);
    const owners = actual.form.fields.filter(field => field.sourceRef === decision.sourceRef);
    if (!priorOwner || owners.length !== 1 ||
        priorOwner.props?.hiddenLabel === true && owners[0].props?.hiddenLabel !== true) {
      issues.push({ reason: "retained_owner_mismatch", fieldId: decision.fieldId });
    }
    for (const id of decision.captionIds) {
      const prior = expected.form.fields.find(field => (field.sourceProps?.originalId || field.id) === id);
      if (!prior) continue; // Already source-proven data-only/compound projection.
      const retained = actual.form.fields.find(field => field.sourceRef === prior.sourceRef);
      if (!retained || retained.componentId !== prior.componentId ||
          canonicalJson(retained.props) !== canonicalJson(prior.props) || retained.dataOnly !== prior.dataOnly) {
        issues.push({ reason: "retained_caption_mismatch", captionId: id });
      }
    }
  }
  return { ok: issues.length === 0, issues, decisions: report?.decisions || [] };
}
