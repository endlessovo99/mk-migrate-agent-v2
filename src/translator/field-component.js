export function componentForSourceType(type, source = {}) {
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
