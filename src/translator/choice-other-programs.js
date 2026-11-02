/** Source code carriers relevant to proving an Other mapping. */
export function choiceOtherBehaviorInputs(scripts = {}, fields = []) {
  return [
    ...(scripts.sources || []).flatMap(item => [item.javascript, item.helperJavascript]),
    ...fields.flatMap(field => [
      ...Object.entries(field.sourceProps?.designerValues || {}).filter(([key]) => /^(?:on|script|function|event)/i.test(key)).map(([, value]) => value),
      ...((field.sourceProps?.captionStructure?.domContext || field.sourceProps?.staticCaptionFact?.domContext)?.inlineScripts || [])
    ])
  ].filter(value => typeof value === "string" && value.trim());
}
