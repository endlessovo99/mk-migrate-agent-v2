import { createHash } from "node:crypto";
import { choiceOtherRevealBindings } from "../dsl/choice-other-reveal.js";
import { captionScriptReferences } from "./caption-script-references.js";

/** Add target presentation only where source identity and script scope are proved. */
export function applyChoiceOtherReveal(form, sourceDraft, behavior) {
  const candidates = (form.fields || []).filter(field => field.sourceProps?.otherTextCompanion &&
    ["xform-checkbox", "xform-radio", "xform-select"].includes(field.componentId));
  if (!candidates.length) return form;
  const sourceControls = sourceDraft.form?.controls || [];
  const sourceFields = [...sourceControls, ...(sourceDraft.form?.dataFields || []),
    ...(sourceDraft.form?.detailTables || []).flatMap(table => [table, ...(table.columns || [])])];
  const behaviorInputs = [
    ...(sourceDraft.scripts?.sources || []).flatMap(item => [item.javascript, item.helperJavascript]),
    ...sourceFields.flatMap(field => [
      ...Object.entries(field.sourceProps?.designerValues || {}).filter(([key]) => /^(?:on|script|function|event)/i.test(key)).map(([, value]) => value),
      ...((field.sourceProps?.captionStructure?.domContext || field.sourceProps?.staticCaptionFact?.domContext)?.inlineScripts || [])
    ])
  ].filter(value => typeof value === "string" && value.trim());
  const scripts = [...new Set([...behaviorInputs, ...(sourceDraft.scripts?.fragments || []).map(item => item.content)]
    .filter(value => typeof value === "string" && value.trim()))];
  const knownDigests = new Set(behaviorInputs.map(value => createHash("sha256").update(value.trim()).digest("hex")));
  const scriptReferences = captionScriptReferences(scripts);
  let result = form;
  for (const initial of candidates) {
    const relation = initial.sourceProps?.otherTextCompanion;
    if (!relation || !["xform-checkbox", "xform-radio", "xform-select"].includes(initial.componentId)) continue;
    const fields = result.fields, choice = fields.find(field => field.sourceRef === initial.sourceRef);
    const notes = fields.filter(field => (field.sourceProps?.originalId || field.id) === relation.id);
    const note = notes[0];
    const sourceChoices = sourceControls.filter(field => field.sourceRef === choice?.sourceRef);
    const sourceNotes = sourceControls.filter(field => field.sourceRef === note?.sourceRef);
    if (notes.length !== 1 || sourceChoices.length !== 1 || sourceNotes.length !== 1 || relation.otherRequired === true ||
        note?.props?.required === true || note?.props?.readOnly === true || sourceNotes[0].required === true ||
        sourceChoices[0].sourceProps?.hardHidden === true || sourceNotes[0].sourceProps?.hardHidden === true ||
        scripts.some(value => value.includes(sourceNotes[0].id)) ||
        scriptReferences.values.some(value => value.includes(sourceNotes[0].id))) continue;
    const trigger = relation.optionValue !== undefined ? choice :
      fields.find(field => (field.sourceProps?.originalId || field.id) === relation.captionId);
    if (!trigger?.sourceRef || !note.sourceRef || trigger.props?.readOnly === true) continue;
    const captionId = relation.captionId || sourceChoices[0].sourceProps?.layoutCell?.captionIds?.[0];
    const caption = sourceControls.find(field => field.id === captionId);
    const context = sourceChoices[0].sourceProps?.otherPairContext ||
      caption?.sourceProps?.staticCaptionFact?.domContext || caption?.sourceProps?.captionStructure?.domContext;
    if (sourceChoices[0].sourceProps?.otherPairContext &&
        (context?.version !== 1 || context.inlineDomainComplete !== true || !Array.isArray(context.inlineScriptDigests) ||
          context.inlineScriptDigests.some(digest => !/^[a-f0-9]{64}$/.test(digest)))) continue;
    if (context?.inlineScriptDigests?.some(digest => !knownDigests.has(digest))) continue;
    if (scripts.length && (!behavior || !context || !behavior.forPair(sourceChoices[0].id, sourceNotes[0].id, context).ok)) continue;
    const presentation = { version: 1, mode: "reveal-on-selection", textSourceRef: note.sourceRef,
      triggerSourceRef: trigger.sourceRef, optionValue: relation.optionValue ?? "selected" };
    const candidate = { ...result, fields: fields.map(field => field === choice ? { ...field, otherPresentation: presentation } : field) };
    try { choiceOtherRevealBindings(candidate); result = candidate; } catch { /* Preserve the source presentation when the compound is not proved. */ }
  }
  return result;
}

export function choiceOtherRevealWarnings(form = {}) {
  return (form.fields || []).filter(field => field.sourceProps?.otherTextCompanion && !field.otherPresentation &&
    ["xform-checkbox", "xform-radio", "xform-select"].includes(field.componentId) && field.dataOnly !== true)
    .map(field => ({
      level: "warning", code: "source.form.choice_other_reveal_needs_manual", path: "/form",
      message: "The source Other choice and explanation remain independent because conditional presentation was not proved safe.",
      details: { fieldId: field.id, companionId: field.sourceProps.otherTextCompanion.id, sourceRef: field.sourceRef }
    }));
}
