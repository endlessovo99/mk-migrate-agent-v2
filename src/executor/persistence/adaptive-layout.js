import { createHash } from "node:crypto";
import { nativeStylesheet } from "./native-stylesheet.js";

export const ADAPTIVE_MAIN_FIELD_CLASS = "mk-adaptive-main-field";

const INTRINSIC_COMPONENTS = new Set([
  "xform-description", "xform-button", "xform-hyperlinks", "xform-hidden"
]);

/** Preserve zero-width companions. Only visible editors consume spare space. */
export function adaptiveFlowItem(item, fields, geometry = {}) {
  if (item.width?.value === 0) return structuredClone(item);
  const field = fields.find(field => field.id === item.referenceId);
  const choiceOther = field?.componentId === "xform-checkbox" &&
    (field.sourceProps?.choiceOtherToggle || field.sourceProps?.otherTextCompanion);
  const basisWidth = sourceEditorHintBasis(item, field, fields, geometry);
  return {
    referenceId: item.referenceId,
    sizing: geometry.stretchDescription && field?.componentId === "xform-description" ? "stretch"
      : !field || field.dataOnly || choiceOther || INTRINSIC_COMPONENTS.has(field.componentId) ? "intrinsic" : "stretch",
    ...(basisWidth ? { basisWidth } : {}),
    ...(geometry.captionWidth ? { captionWidth: geometry.captionWidth } : {})
  };
}

// Flex wrapping collects hypothetical item widths before distributing spare
// space. A zero-basis editor lets a long hint consume the line, squeezing the
// editor to its remainder. Keep only this source-proved pair's wrapping basis;
// min-width:0/max-width:100% still let it shrink in a narrower cell.
function sourceEditorHintBasis(item, field, fields, geometry) {
  const source = field?.sourceProps, flow = geometry.contentFlow;
  if (field?.componentId !== "xform-input" || field.dataOnly || source?.designerType !== "inputText" ||
      source.designerId !== field.id || item.width?.unit !== "px" || !(item.width.value > 0) ||
      !Number.isFinite(item.width.value)) return undefined;
  const declared = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(String(source.designerValues?.width || ""));
  if (!declared || !(Number(declared[1]) > 0) || Number(declared[1]) > item.width.value) return undefined;
  const line = flow?.lines?.find(line => line.includes(field.id));
  if (line?.length !== 2 || line[0] !== field.id) return undefined;
  const hint = fields.find(field => field.id === line[1]);
  if (hint?.componentId !== "xform-description" || hint.dataOnly || hint.sourceProps?.designerType !== "textLabel" ||
      hint.props?.content !== hint.sourceProps.designerValues?.content ||
      !/^[^<>\r\n]{5,}$/u.test(String(hint.props?.content || "").trim())) return undefined;
  return item.width.value;
}

export function adaptiveItemStyle(item, fields, geometry) {
  const projected = adaptiveFlowItem(item, fields, geometry);
  return {
    flex: projected.width ? "0 0 auto" : projected.sizing === "stretch" ? `1 1 ${projected.basisWidth ? `${projected.basisWidth}px` : "0"}` : "0 1 auto",
    minWidth: 0, maxWidth: "100%", overflow: "visible",
    width: projected.width ? `${projected.width.value}${projected.width.unit}` : "auto",
    ...(projected.captionWidth ? { "--mk-adaptive-caption-width": projected.captionWidth } : {})
  };
}

export function effectiveCellFlow(cell, adaptive) {
  if (cell.contentFlow || !adaptive || cell.refType !== "field") return cell.contentFlow;
  return { lines: [cell.refIds], items: cell.refIds.map(referenceId => ({ referenceId })) };
}

/**
 * Private, fixed native presentation infrastructure. No source CSS, HTML or
 * JavaScript is accepted here; the scope is bound to the created main table.
 */
export function adaptiveStyles(tableName) {
  const scope = `mk-adaptive-${createHash("sha256").update(String(tableName)).digest("hex").slice(0, 24)}`;
  // A marker preceding main scopes its rendered siblings without separating
  // appearance from the designer's direct-child .receiver.
  const root = `.${scope} ~ * .${ADAPTIVE_MAIN_FIELD_CLASS}`;
  const css = [
    `${root} .ele-xform-fieldset-label,`,
    `${root} .ele-xform-fieldset-label > span {`,
    "  width: auto !important;",
    "  max-width: none !important;",
    "  min-width: 0 !important;",
    "  white-space: normal !important;",
    "  overflow-wrap: anywhere !important;",
    "}",
    `${root} .ele-xform-fieldset-horizontal > .ele-xform-fieldset-label-wrap {`,
    "  flex: 0 1 auto !important;",
    "  min-width: 0 !important;",
    "  max-width: 50% !important;",
    "}",
    `${root}[style*="--mk-adaptive-caption-width"] .ele-xform-fieldset-horizontal > .ele-xform-fieldset-label-wrap {`,
    "  flex: 0 0 var(--mk-adaptive-caption-width) !important;",
    // Existing classic desktop budget: 8 * 14px title + 32px padding + 1px border.
    "  min-width: min(50%, 145px) !important;",
    "}",
    `${root} .ele-xform-fieldset-control-wrap {`,
    "  flex: 1 1 0% !important;",
    "  min-width: 0 !important;",
    "}",
    `${root} .ele-xform-fieldset-control,`,
    `${root} .ele-xform-fieldset-control-main {`,
    "  min-width: 0 !important;",
    "  max-width: 100% !important;",
    "}"
  ].join("\n");
  return {
    scope, css,
    carrier: nativeStylesheet(`${scope}-styles`, css)
  };
}

export function adaptiveView(main, tableName) {
  const { scope, carrier } = adaptiveStyles(tableName);
  return [{
    key: scope, type: "div", kind: "container",
    controlProps: { id: scope, className: scope, style: { width: "100%", minWidth: 0 } },
    children: [carrier]
  }, main];
}

export function adaptiveStyleContract(tableName) {
  const { scope, carrier } = adaptiveStyles(tableName);
  return Object.fromEntries(["desktop", "mobile"].map(scene => [scene, {
    rootCount: 1, rootChildCount: 2, styleCarrierCount: 1, layoutShellsValid: true,
    root: { type: "@elem/xform-appearance", kind: "container", controlProps: { $$tableName: tableName } },
    scope: { key: scope, type: "div", kind: "container",
      controlProps: { id: scope, className: scope, style: { width: "100%", minWidth: 0 } } },
    carrier, childCount: 1, main: { key: "main", type: "main", kind: "container",
      controlProps: { importBtn: null, onDesktopImport: null, id: "main" } }
  }]));
}
