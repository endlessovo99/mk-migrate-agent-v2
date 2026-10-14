import { isSourceDescriptionControl } from "./source-description-control.js";
import { cleanText } from "./xml-utils.js";

const OTHER_OPTION_VALUE = "other_";
const OTHER_OPTION_TYPE = "other";

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
        otherRequired: true,
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
 * Folds a recorded other-text companion onto one native radio/checkbox
 * option and keeps the companion as persisted, non-rendered data.
 */
export function mapChoiceOtherCompanions(fields = []) {
  const relations = choiceOtherRelations(fields);
  if (!relations.companions.size && !relations.captions.size) return fields;

  return fields.map((field) => {
    if (field?.type === "detailTable") {
      return {
        ...field,
        columns: (field.columns || []).map((column) =>
          mapChoiceOtherField(column, relations)
        )
      };
    }
    return mapChoiceOtherField(field, relations);
  });
}

function mapChoiceOtherField(field, relations) {
  if (relations.companions.has(field?.id)) {
    const { required: _required, ...props } = field.props || {};
    return {
      ...field,
      props,
      dataOnly: true,
      sourceProps: {
        ...field.sourceProps,
        choiceOtherFor: relations.companions.get(field.id)
      }
    };
  }
  if (relations.captions.has(field?.id)) {
    return {
      ...field,
      dataOnly: true,
      sourceProps: {
        ...field.sourceProps,
        choiceOtherCaptionFor: relations.captions.get(field.id)
      }
    };
  }
  const companion = field?.sourceProps?.otherTextCompanion;
  if (!isTargetChoiceField(field) || !companion?.id) return field;

  const options = Array.isArray(field.props?.options) ? [...field.props.options] : [];
  if (!options.some((option) => option?.type === OTHER_OPTION_TYPE)) {
    const nativeOther = {
      label: "其他",
      value: OTHER_OPTION_VALUE,
      type: OTHER_OPTION_TYPE,
      isRequired: companion.otherRequired !== false
    };
    const existingIndex = companion.optionValue === undefined ? -1
      : options.findIndex((option) => option.value === companion.optionValue);
    if (existingIndex >= 0) options[existingIndex] = nativeOther;
    else options.push(nativeOther);
  }
  return {
    ...field,
    props: {
      ...field.props,
      options
    },
    sourceProps: {
      ...field.sourceProps,
      otherTextCompanionId: companion.id
    }
  };
}

function choiceOtherRelations(fields = []) {
  const companions = new Map();
  const captions = new Map();
  for (const field of fields) {
    recordChoiceOtherRelation(companions, captions, field);
    for (const column of field?.columns || []) {
      recordChoiceOtherRelation(companions, captions, column);
    }
  }
  return { companions, captions };
}

function recordChoiceOtherRelation(companions, captions, field) {
  const companion = field?.sourceProps?.otherTextCompanion;
  if (!isTargetChoiceField(field) || !companion?.id) return;
  companions.set(companion.id, field.id);
  if (companion.captionId) captions.set(companion.captionId, field.id);
}

function isSourceChoiceControl(control) {
  const designerType = String(control?.source?.designerType || "").toLowerCase();
  return ["checkbox", "radio"].includes(control?.type) ||
    ["inputcheckbox", "checkbox", "inputradio", "radio"].includes(designerType);
}

function isTargetChoiceField(field) {
  return ["xform-checkbox", "xform-radio"].includes(field?.componentId);
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
