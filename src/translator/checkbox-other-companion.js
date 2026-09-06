import { isSourceDescriptionControl } from "./source-description-control.js";
import { cleanText } from "./xml-utils.js";

export const CHECKBOX_OTHER_OPTION_VALUE = "other_";
export const CHECKBOX_OTHER_OPTION_TYPE = "other";

/**
 * Records same-cell checkbox + 「其他」 caption + free-text evidence as a
 * source fact. Target folding belongs at the DSL mapping seam.
 */
export function annotateCheckboxOtherCompanions(controls = []) {
  for (let index = 0; index < controls.length; index += 1) {
    const checkbox = controls[index];
    if (!isSourceCheckboxControl(checkbox) || checkbox.source?.otherTextCompanion) continue;

    let offset = index + 1;
    let caption;
    if (offset < controls.length && isOtherCaptionControl(controls[offset])) {
      caption = controls[offset];
      offset += 1;
    }
    const companion = controls[offset];
    if (!isOtherTextCompanion(companion, caption)) continue;

    checkbox.source = {
      ...checkbox.source,
      otherTextCompanion: {
        id: companion.id,
        otherRequired: true,
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
 * Folds a recorded checkbox other-text companion onto one native checkbox
 * option and keeps the companion as persisted, non-rendered data.
 */
export function mapCheckboxOtherCompanions(fields = []) {
  const relations = checkboxOtherRelations(fields);
  if (!relations.companions.size && !relations.captions.size) return fields;

  return fields.map((field) => {
    if (field?.type === "detailTable") {
      return {
        ...field,
        columns: (field.columns || []).map((column) =>
          mapCheckboxOtherField(column, relations)
        )
      };
    }
    return mapCheckboxOtherField(field, relations);
  });
}

function mapCheckboxOtherField(field, relations) {
  if (relations.companions.has(field?.id)) {
    const { required: _required, ...props } = field.props || {};
    return {
      ...field,
      props,
      dataOnly: true,
      sourceProps: {
        ...field.sourceProps,
        checkboxOtherFor: relations.companions.get(field.id)
      }
    };
  }
  if (relations.captions.has(field?.id)) {
    return {
      ...field,
      dataOnly: true,
      sourceProps: {
        ...field.sourceProps,
        checkboxOtherCaptionFor: relations.captions.get(field.id)
      }
    };
  }
  const companion = field?.sourceProps?.otherTextCompanion;
  if (field?.componentId !== "xform-checkbox" || !companion?.id) return field;

  const options = Array.isArray(field.props?.options) ? [...field.props.options] : [];
  if (!options.some((option) => isOtherOption(option))) {
    options.push({
      label: otherOptionLabel(companion),
      value: CHECKBOX_OTHER_OPTION_VALUE,
      type: CHECKBOX_OTHER_OPTION_TYPE,
      isRequired: companion.otherRequired !== false
    });
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

function checkboxOtherRelations(fields = []) {
  const companions = new Map();
  const captions = new Map();
  for (const field of fields) {
    recordCheckboxOtherRelation(companions, captions, field);
    for (const column of field?.columns || []) {
      recordCheckboxOtherRelation(companions, captions, column);
    }
  }
  return { companions, captions };
}

function recordCheckboxOtherRelation(companions, captions, field) {
  const companion = field?.sourceProps?.otherTextCompanion;
  if (field?.componentId !== "xform-checkbox" || !companion?.id) return;
  companions.set(companion.id, field.id);
  if (companion.captionId) captions.set(companion.captionId, field.id);
}

function isSourceCheckboxControl(control) {
  const designerType = String(control?.source?.designerType || "").toLowerCase();
  return control?.type === "checkbox" || ["inputcheckbox", "checkbox"].includes(designerType);
}

function isOtherCaptionControl(control) {
  if (!isSourceDescriptionControl(control)) return false;
  return isOtherCaptionText(control.title || control.source?.designerValues?.content || "");
}

function isOtherTextCompanion(companion, caption) {
  if (!caption || !companion || companion.type === "detailTable") return false;
  if (isSourceCheckboxControl(companion) || isSourceDescriptionControl(companion)) return false;
  const designerType = String(companion.source?.designerType || "").toLowerCase();
  if (companion.type !== "text" && !["inputtext", "text"].includes(designerType)) return false;
  if (companion.source?.hardHidden === true) return false;
  return true;
}

function isOtherCaptionText(value) {
  return /^\s*其他[:：]?\s*$/u.test(cleanText(value));
}

function otherOptionLabel(companion) {
  const caption = cleanText(companion?.caption || "").replace(/[:：]\s*$/u, "");
  return caption || "其他";
}

function isOtherOption(option) {
  return option?.type === CHECKBOX_OTHER_OPTION_TYPE ||
    option?.value === CHECKBOX_OTHER_OPTION_VALUE;
}
