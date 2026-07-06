import { COMPONENTS_BY_ID } from "./catalogs.js";

export const MK_COMPONENTS = new Map(
  [...COMPONENTS_BY_ID.values()]
    .filter((component) => component.kind === "field")
    .map((component) => [component.componentId, mkMeta(component.componentId)])
);

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
