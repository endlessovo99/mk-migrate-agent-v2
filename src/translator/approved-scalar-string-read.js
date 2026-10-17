// A caller must validate the source-bound approved decision before supplying IDs.
// This read contract never changes the persisted field/widget metadata.
export function approvedScalarStringReadExpression(fieldId, form = {}, approvedFieldIds = []) {
  const ids = approvedFieldIds instanceof Set ? approvedFieldIds : new Set(Array.isArray(approvedFieldIds) ? approvedFieldIds : []);
  if (typeof fieldId !== "string" || !/^[A-Za-z_][\w]*$/.test(fieldId) || !ids.has(fieldId)) return undefined;
  const fields = (form.fields || []).filter(field => field.id === fieldId);
  if (fields.length !== 1) return undefined;
  const field = fields[0], source = field.sourceProps || {};
  const fact = source.mainStringValueBindingFact;
  const hasProjectedStringMetadata = fact?.version === 1 && fact.fieldId === fieldId &&
    fact.metadata?.count === 1 && fact.metadata.type === "String" &&
    ["fdDesignerHtml", "fdDisplayJsp", "fdMetadataXml"].every(key => /^[a-f0-9]{64}$/.test(fact.sourceHashes?.[key] || ""));
  const hasStringMetadata = source.metadataId === fieldId && source.metadataKind === "simple" && source.metadataAttributes?.type === "String" ||
    hasProjectedStringMetadata && [undefined, fieldId].includes(source.metadataId) &&
      [undefined, "simple"].includes(source.metadataKind) && [undefined, "String"].includes(source.metadataAttributes?.type);
  if (field.dataOnly === true || field.columns ||
      !(field.type === "radio" && field.componentId === "xform-radio" || field.type === "singleSelect" && field.componentId === "xform-select") ||
      source.designerId !== fieldId || !hasStringMetadata ||
      ![undefined, "", "String"].includes(source.designerValues?.dataType) ||
      field.props?.multiple === true || ["multiple", "tags"].includes(field.props?.mode) ||
      (field.props?.options || []).some(option => typeof option.value !== "string")) return undefined;
  return '(function(__approvedValue) { ' +
    'if (Array.isArray(__approvedValue)) { ' +
    'if (__approvedValue.length === 0) return ""; ' +
    'if (__approvedValue.length !== 1 || typeof __approvedValue[0] !== "string") throw "Expected one selected String value."; ' +
    'return __approvedValue[0]; } ' +
    'if (__approvedValue === undefined || __approvedValue === null) return ""; ' +
    'if (typeof __approvedValue !== "string") throw "Expected one selected String value."; ' +
    'return __approvedValue; })(MKXFORM.getValue(' + JSON.stringify(fieldId) + '))';
}
