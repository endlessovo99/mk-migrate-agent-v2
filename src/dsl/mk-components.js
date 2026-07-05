export const MK_COMPONENTS = new Map([
  ["xform-input", mkMeta("xform-input")],
  ["xform-textarea", mkMeta("xform-textarea")],
  ["xform-radio", mkMeta("xform-radio")],
  ["xform-checkbox", mkMeta("xform-checkbox")],
  ["xform-select", mkMeta("xform-select")],
  ["xform-select~multi", mkMeta("xform-select~multi")],
  ["xform-datetime", mkMeta("xform-datetime")],
  ["xform-number", mkMeta("xform-number")],
  ["xform-address", mkMeta("xform-address")],
  ["xform-attach", mkMeta("xform-attach")],
  ["xform-description", mkMeta("xform-description")],
  ["xform-detail-table", mkMeta("xform-detail-table")]
]);

export function mkForFieldType(fieldType) {
  const component = {
    text: "xform-input",
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
    detailTable: "xform-detail-table"
  }[fieldType] || "xform-input";

  return {
    component,
    ...MK_COMPONENTS.get(component)
  };
}

export function mkForComponent(component) {
  return {
    component,
    ...MK_COMPONENTS.get(component)
  };
}

function mkMeta(component) {
  return {
    group: "basic",
    itemTid: `xform-ide-sidebar-tabPane-control-@elem-${component}`,
    sourceComponent: `@elem/${component}`
  };
}
