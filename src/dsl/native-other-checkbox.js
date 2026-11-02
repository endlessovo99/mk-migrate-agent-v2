/** Recognize the explicitly named source Other option, not labels such as Other employees. */
export function isNativeOtherLabel(value) {
  return typeof value === "string" && /^(?:(?:\d+\s*[.．、)）]|[（(]\d+[）)]\s*[.．、]?)\s*)?(?:其他|其它)(?:附件|方式)?\s*(?:[（(][^）)]*[）)])?\s*[:：]?$/u.test(value.trim());
}

/** Validate a source-bound checkbox or radio mapped to MK's native Other option. */
export function nativeOtherChoiceBindings(form = {}) {
  const fields = form.fields || [];
  return fields.filter(field => field.nativeOther !== undefined).map(choice => {
    const marker = choice.nativeOther, relation = choice.sourceProps?.otherTextCompanion;
    const captions = marker?.captionSourceRef ? fields.filter(field => field.sourceRef === marker.captionSourceRef) : [];
    const texts = fields.filter(field => field.sourceRef === marker?.textSourceRef);
    const options = choice.props?.options;
    const regularLabels = Array.isArray(options) ? options.filter(option => option?.type !== "other").map(option => option?.label) : [];
    const paired = marker?.version === 1 && Object.keys(marker).sort().join(",") === "captionSourceRef,textSourceRef,version" &&
      relation && texts.length === 1 && texts[0].dataOnly === true &&
      (relation.captionId ? captions.length === 1 && captions[0].dataOnly === true &&
        (captions[0].sourceProps?.originalId || captions[0].id) === relation.captionId :
        marker.captionSourceRef === null && relation.optionValue !== undefined) &&
      (texts[0].sourceProps?.originalId || texts[0].id) === relation.id;
    const standalone = marker?.version === 2 && Object.keys(marker).sort().join(",") === "sourceOptionValue,version" &&
      typeof marker.sourceOptionValue === "string" && marker.sourceOptionValue.length > 0 && !relation;
    if (!(paired || standalone) || !["xform-checkbox", "xform-radio"].includes(choice.componentId) || choice.dataOnly ||
        !Array.isArray(options) || options.length < 1 ||
        choice.componentId === "xform-checkbox" && (regularLabels.some(label => typeof label !== "string" || !label) ||
          new Set(regularLabels).size !== regularLabels.length) ||
        options.filter(option => option.type === "other" || option.value.startsWith("other_")).length !== 1 ||
        options.at(-1)?.type !== "other" || options.at(-1)?.value !== "other_") {
      const error = new Error(`Native Other checkbox is not bound to its source fields (${choice.id}).`);
      error.code = "dsl.form.native_other_checkbox_invalid";
      throw error;
    }
    return { choiceId: choice.id, ...(paired ? { textId: texts[0].id } : {}), componentId: choice.componentId };
  });
}

export function nativeOtherCheckboxBindings(form = {}) {
  return nativeOtherChoiceBindings(form).filter(binding => binding.componentId === "xform-checkbox");
}
