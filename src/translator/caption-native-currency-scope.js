import { parseStaticMarkupAttributes } from "./source-static-markup.js";

// Reuse the native-currency value contract already implemented by
// chinaValueRuntimeCandidates in sysform-jsp-scripts.js. Impact proof is stricter:
// every currency control must have matching typed source and literal readonly
// runtime bindings. This does not add/rewrite a migrated action or ignore a URL.
export function captionNativeCurrencyScope(text, form, originals) {
  if (!/^\s*Com_IncludeFile\(\s*(['"])chinaValue_script\.js\1\s*,\s*(['"])\.\.\/sys\/xform\/designer\/chinaValue\/\2\s*\)\s*;?\s*$/.test(text)) return undefined;
  const currency = originals.filter(field => String(field.sourceProps?.designerType || "").toLowerCase() === "chinavalue");
  const fields = form.fields || [], bindings = [];
  if (!currency.length || fields.flatMap(field => [field, ...(field.columns || [])])
    .filter(field => String(field.sourceProps?.designerType || "").toLowerCase() === "chinavalue").length !== currency.length) return undefined;
  for (const original of currency) {
    const candidates = fields.filter(field => field.id === original.id), target = candidates[0];
    const sourceId = original.sourceProps?.designerValues?.relatedid;
    const amounts = fields.filter(field => field.id === sourceId), amount = amounts[0];
    const runtime = original.sourceProps?.runtimeTextReadOnly, evidence = runtime?.evidence;
    const attributes = evidence?.length === 1 && parseStaticMarkupAttributes(evidence[0].htmlElementProperties);
    if (candidates.length !== 1 || target.dataOnly || target.type !== "text" || target.componentId !== "xform-input" ||
        target.props?.readOnly !== true || amounts.length !== 1 || amount.dataOnly || amount.type !== "number" ||
        original.sourceProps.metadataAttributes?.relatedid !== sourceId ||
        runtime?.readOnly !== true || runtime.source !== "fdDisplayJsp" || !attributes ||
        evidence[0].property !== `extendDataFormInfo.value(${original.id})` ||
        [...attributes.keys()].some(key => !["relatedid", "chinavalue", "isrow"].includes(key)) ||
        attributes.get("relatedid") !== sourceId || attributes.get("chinavalue") !== "true" || attributes.get("isrow") !== "false") return undefined;
    bindings.push({ sourceId, targetId: original.id, basis: "typed-readonly-native-currency-binding" });
  }
  return { targets: [], parentReads: [], dataTargets: bindings.flatMap(binding => [binding.sourceId, binding.targetId]), bindings };
}
