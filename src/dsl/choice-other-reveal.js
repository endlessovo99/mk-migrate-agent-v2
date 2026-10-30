/** Validate the explicit, source-bound presentation policy in a migration DSL. */
export function choiceOtherRevealBindings(form = {}) {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const bySource = ref => fields.filter(field => field?.sourceRef === ref);
  const byOriginalId = id => fields.filter(field => (field?.sourceProps?.originalId || field?.id) === id);
  const bindings = [];
  for (const choice of fields.filter(field => field?.otherPresentation !== undefined)) {
    const presentation = choice.otherPresentation, relation = choice.sourceProps?.otherTextCompanion;
    const texts = bySource(presentation?.textSourceRef), triggers = bySource(presentation?.triggerSourceRef);
    const text = texts[0], trigger = triggers[0];
    const validHeader = presentation && presentation.version === 1 && presentation.mode === "reveal-on-selection" &&
      Object.keys(presentation).sort().join(",") === "mode,optionValue,textSourceRef,triggerSourceRef,version" &&
      typeof presentation.optionValue === "string" && presentation.optionValue.length > 0 &&
      ["xform-checkbox", "xform-radio", "xform-select"].includes(choice.componentId) && choice.dataOnly !== true &&
      relation && relation.otherRequired !== true && texts.length === 1 && triggers.length === 1 &&
      text?.componentId === "xform-input" && text.dataOnly !== true && text.props?.required !== true && text.props?.readOnly !== true &&
      trigger?.props?.readOnly !== true &&
      byOriginalId(relation.id).length === 1 && byOriginalId(relation.id)[0] === text &&
      choice.props?.hiddenLabel === true && text.props?.hiddenLabel === true;
    if (!validHeader) throw invalid(choice.id);
    if (relation.optionValue !== undefined) {
      const options = choice.props?.options;
      if (trigger !== choice || presentation.optionValue !== relation.optionValue ||
          !Array.isArray(options) || options.filter(option => option.value === relation.optionValue).length !== 1 ||
          (choice.componentId !== "xform-select" && options.at(-1)?.value !== relation.optionValue) ||
          options.some(option => option.type === "other" || option.value === "other_")) throw invalid(choice.id);
    } else {
      const captions = byOriginalId(relation.captionId);
      const toggle = trigger?.sourceProps?.choiceOtherToggle;
      if (captions.length !== 1 || captions[0] !== trigger || trigger?.generated !== true ||
          trigger.componentId !== "xform-checkbox" || toggle?.version !== 1 ||
          toggle.choiceSourceRef !== choice.sourceRef || toggle.textSourceRef !== text.sourceRef ||
          trigger.props?.options?.length !== 1 || trigger.props.options[0]?.value !== "selected" ||
          presentation.optionValue !== "selected") throw invalid(choice.id);
    }
    const binding = { choiceId: choice.id, triggerId: trigger.id, textId: text.id, optionValue: presentation.optionValue };
    if (!hasSingleAdjacentFlow(form.layout, binding.triggerId, binding.textId) ||
        bindings.some(existing => existing.triggerId === binding.triggerId || existing.textId === binding.textId)) throw invalid(choice.id);
    bindings.push(binding);
  }
  return bindings;
}

function hasSingleAdjacentFlow(layout, first, second) {
  let matches = 0;
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (node.contentFlow?.lines) for (const line of node.contentFlow.lines) {
      const index = Array.isArray(line) ? line.indexOf(first) : -1;
      const item = node.contentFlow.items?.find(value => value.referenceId === second);
      const width = item?.width;
      if (index >= 0 && line[index + 1] === second &&
          (!width || Number.isFinite(width.value) && width.value > 0 && ["px", "%"].includes(width.unit))) matches += 1;
    }
    for (const child of node.children || []) visit(child);
  };
  for (const row of layout?.mkTree || []) visit(row);
  return matches === 1;
}

function invalid(id) {
  const error = new Error(`Other reveal presentation is not bound to one safe source relationship (${id || "unknown"}).`);
  error.code = "dsl.form.choice_other_reveal_invalid";
  return error;
}
