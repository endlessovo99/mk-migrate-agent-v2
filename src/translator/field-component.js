export function componentForSourceType(type, source = {}) {
  if (isSourceCalculation(type, source)) {
    return "xform-calculate";
  }
  if (source.sourceProps?.designerType === "address") return "xform-address";
  return {
    text: source.sourceProps?.metadataKind === "element" ? "xform-address" : "xform-input",
    longText: "xform-textarea",
    number: "xform-number",
    date: "xform-datetime",
    dateTime: "xform-datetime",
    singleSelect: "xform-select",
    multiSelect: "xform-select~multi",
    radio: "xform-radio",
    checkbox: "xform-checkbox",
    attachment: "xform-attach",
    description: "xform-description",
    RestDialog: "xform-input",
    LinkLabel: "xform-description",
    button: "xform-button"
  }[type] || "xform-input";
}

function isSourceCalculation(type, source) {
  if (String(source.sourceProps?.designerType || "").toLowerCase() === "calculation") return true;
  if (type !== "number") return false;
  const designerFormula = String(source.sourceProps?.designerValues?.formula || "").trim();
  const metadata = source.sourceProps?.metadataAttributes || {};
  const metadataFormula = String(metadata.defaultValue || "").trim();
  return Boolean(
    (designerFormula.includes("$") && designerFormula.trim()) ||
    (String(metadata.formula || "").toLowerCase() === "true" && metadataFormula.includes("$"))
  );
}
