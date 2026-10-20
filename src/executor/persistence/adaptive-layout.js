import { createHash } from "node:crypto";

const INTRINSIC_COMPONENTS = new Set([
  "xform-description", "xform-button", "xform-hyperlinks", "xform-hidden"
]);

/** Preserve zero-width companions. Only visible editors consume spare space. */
export function adaptiveFlowItem(item, fields) {
  if (item.width?.value === 0) return structuredClone(item);
  const field = fields.find(field => field.id === item.referenceId);
  return {
    referenceId: item.referenceId,
    sizing: !field || field.dataOnly || INTRINSIC_COMPONENTS.has(field.componentId)
      ? "intrinsic" : "stretch"
  };
}

export function adaptiveItemStyle(item, fields) {
  const projected = adaptiveFlowItem(item, fields);
  return {
    flex: projected.width ? "0 0 auto" : projected.sizing === "stretch" ? "1 1 0" : "0 1 auto",
    minWidth: 0, maxWidth: "100%", overflow: "visible",
    width: projected.width ? `${projected.width.value}${projected.width.unit}` : "auto"
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
  const root = `.${scope}`;
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
    carrier: {
      key: `${scope}-styles`, type: "@elem/xform-html", kind: "control",
      controlProps: { $$isDesign: false, source: { html: "", css, javascript: "" } }
    }
  };
}

export function adaptiveView(main, tableName) {
  const { scope, carrier } = adaptiveStyles(tableName);
  return {
    key: scope, type: "div", kind: "container",
    controlProps: { id: scope, className: scope, style: { width: "100%", minWidth: 0 } },
    children: [carrier, main]
  };
}

export function adaptiveStyleContract(tableName) {
  const { scope, carrier } = adaptiveStyles(tableName);
  return Object.fromEntries(["desktop", "mobile"].map(scene => [scene, {
    rootCount: 1, rootChildCount: 1, styleCarrierCount: 1, layoutShellsValid: true,
    root: { type: "@elem/xform-appearance", kind: "container", controlProps: { $$tableName: tableName } },
    scope: { key: scope, type: "div", kind: "container",
      controlProps: { id: scope, className: scope, style: { width: "100%", minWidth: 0 } } },
    carrier, childCount: 2, main: { key: "main", type: "main", kind: "container",
      controlProps: { importBtn: null, onDesktopImport: null, id: "main" } }
  }]));
}
