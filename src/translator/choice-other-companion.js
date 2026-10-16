import { isSourceDescriptionControl } from "./source-description-control.js";
import { cleanText } from "./xml-utils.js";

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
 * A neighboring textbox remains an independent source field. Adjacency alone
 * proves neither a composite option encoding nor conditional validation/clear
 * behavior, so keep both fields and their caption on the ordinary mapping.
 */
export function mapChoiceOtherCompanions(fields = []) {
  return fields;
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
  return Boolean(choiceTitle && title.startsWith(choiceTitle) &&
    isOtherCaptionText(title.slice(choiceTitle.length).replace(/^\s*[:：]\s*/u, "")));
}
