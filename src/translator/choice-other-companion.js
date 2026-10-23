import { isSourceDescriptionControl } from "./source-description-control.js";
import { cleanText } from "./xml-utils.js";
import { captionScriptReferences } from "./caption-script-references.js";

/**
 * Records same-cell radio/checkbox other-choice + free-text evidence as a
 * source fact. Target folding belongs at the DSL mapping seam.
 */
export function annotateChoiceOtherCompanions(controls = []) {
  for (let index = 0; index < controls.length; index += 1) {
    const choice = controls[index];
    if (!isSourceChoiceControl(choice) || choice.source?.otherTextCompanion) continue;
    const otherOptions = (choice.options || []).filter((option) => isOtherCaptionText(option.label));
    if (otherOptions.length > 1) continue;

    let offset = index + 1;
    let caption;
    if (offset < controls.length && isOtherCaptionControl(controls[offset])) {
      caption = controls[offset];
      offset += 1;
    }
    const companion = controls[offset];
    if (!isOtherTextCompanion(companion)) continue;
    if (!caption && (!otherOptions.length || !hasMatchingOtherTitle(choice, companion))) continue;

    choice.source = {
      ...choice.source,
      otherTextCompanion: {
        id: companion.id,
        otherRequired: companion.required === true,
        ...(otherOptions.length ? { optionValue: otherOptions[0].value, optionLabel: otherOptions[0].label } : {}),
        ...(caption
          ? {
              captionId: caption.id,
              caption: cleanText(caption.title || caption.source?.designerValues?.content || "")
            }
          : {})
      }
    };
  }
  return controls;
}

/**
 * Keep business choices and explanation text independent. A fixed Other caption
 * may supply a separate native checkbox when no source option represents it.
 * Its selection is presentation state, never an invented business choice code.
 */
export function mapChoiceOtherCompanions(fields = [], sourceScripts = {}, behavior) {
  const replacements = new Map();
  const pairs = fields.filter(field => field.componentId === "xform-checkbox" &&
    field.sourceProps?.otherTextCompanion?.captionId);
  for (const choice of pairs) {
    const relation = choice.sourceProps.otherTextCompanion;
    const text = fields.find(field => field.id === relation.id);
    const caption = fields.find(field => field.id === relation.captionId);
    if (pairs.filter(field => field.sourceProps.otherTextCompanion.captionId === relation.captionId).length !== 1 ||
        !text || text.componentId !== "xform-input" || text.dataOnly ||
        !caption || caption.componentId !== "xform-description" || caption.dataOnly ||
        !isOtherCaptionText(caption.props?.content || caption.title) ||
        referencedCaption(caption, choice, sourceScripts, fields, behavior)) continue;
    if (relation.optionValue !== undefined) {
      if (!(choice.props?.options || []).some(option => option.value === relation.optionValue && option.type !== "other")) continue;
      replacements.set(caption.id, { ...caption, dataOnly: true });
      continue;
    }
    replacements.set(caption.id, {
      ...caption,
      title: cleanText(caption.title).replace(/[:：]\s*$/u, ""),
      type: "checkbox",
      componentId: "xform-checkbox",
      props: {
        options: [{ label: cleanText(caption.title).replace(/[:：]\s*$/u, ""), value: "selected" }],
        hiddenLabel: true,
        ...(choice.props?.readOnly === true || text.props?.readOnly === true ? { readOnly: true } : {})
      },
      sourceProps: {
        ...caption.sourceProps,
        choiceOtherToggle: { version: 1, choiceSourceRef: choice.sourceRef, textSourceRef: text.sourceRef }
      },
      generated: true,
      reason: "The source Other caption becomes a separately stored native checkbox; original choice codes and explanation text remain unchanged."
    });
  }
  return fields.map(field => replacements.get(field.id) || field);
}

function referencedCaption(caption, choice, scripts, fields, behavior) {
  const texts = [...(scripts.sources || []).flatMap(source => [source.javascript, source.helperJavascript]),
    ...(scripts.fragments || []).map(fragment => fragment.content),
    ...(scripts.actions || []).map(action => action.function || action.sourceText),
    ...fields.flatMap(field => [
      ...Object.entries(field.sourceProps?.designerValues || {}).filter(([key]) => /^(?:on|script|function|event)/i.test(key)).map(([, value]) => value),
      ...(field.sourceProps?.captionStructure?.domContext?.inlineScripts || field.sourceProps?.staticCaptionFact?.domContext?.inlineScripts || [])
    ])].filter(text => typeof text === "string" && text.trim());
  const references = captionScriptReferences(texts);
  if (texts.some(text => text.includes(caption.id)) || references.values.some(text => text.includes(caption.id))) return true;
  if (references.opaque && !scripts.sources?.length && scripts.fragments?.length) return true;
  const context = caption.sourceProps?.captionStructure?.domContext || caption.sourceProps?.staticCaptionFact?.domContext;
  const impact = behavior?.forPair(choice.id, caption.id, context);
  return impact ? !impact.ok : references.opaque;
}

function isSourceChoiceControl(control) {
  const designerType = String(control?.source?.designerType || "").toLowerCase();
  return ["checkbox", "radio"].includes(control?.type) ||
    ["inputcheckbox", "checkbox", "inputradio", "radio"].includes(designerType);
}

function isOtherCaptionControl(control) {
  if (!isSourceDescriptionControl(control)) return false;
  return isOtherCaptionText(control.title || control.source?.designerValues?.content || "");
}

function isOtherTextCompanion(companion) {
  if (!companion || companion.type === "detailTable") return false;
  if (isSourceChoiceControl(companion) || isSourceDescriptionControl(companion)) return false;
  const designerType = String(companion.source?.designerType || "").toLowerCase();
  if (companion.type !== "text" && !["inputtext", "text"].includes(designerType)) return false;
  if (companion.source?.hardHidden === true) return false;
  return true;
}

function isOtherCaptionText(value) {
  return /^(?:(?:\d+\s*[.．、)）]|[（(]\d+[）)]\s*[.．、]?)\s*)?其他(?:附件)?\s*(?:[（(][^）)]*[）)])?\s*[:：]?$/u.test(cleanText(value));
}

function hasMatchingOtherTitle(choice, companion) {
  const title = cleanText(companion.title || companion.source?.designerValues?.label || "");
  if (isOtherCaptionText(title)) return true;
  const choiceTitle = cleanText(choice.source?.designerValues?.label || choice.title || "")
    .replace(/[:：]\s*$/u, "");
  return Boolean(choiceTitle && (
    title.startsWith(choiceTitle) &&
      isOtherCaptionText(title.slice(choiceTitle.length).replace(/^\s*[:：]\s*/u, "")) ||
    title.endsWith(choiceTitle) && isOtherCaptionText(title.slice(0, -choiceTitle.length))
  ));
}
