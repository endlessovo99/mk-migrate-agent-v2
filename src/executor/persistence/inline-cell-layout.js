// GridItem wraps its contents in a vertical receiver (IDE) or inner div
// (runtime). A native xform-row is needed inside it; styling GridItem alone
// does not arrange the field controls horizontally.
export function inlineCellLayout(cell, fields = []) {
  if (cell.contentFlow || cell.keepInline !== true || cell.refType !== "field" || !Array.isArray(cell.refIds) || cell.refIds.length < 2) {
    return undefined;
  }
  const byId = new Map(fields.map((field) => [field.id, field]));
  const shortDescriptions = cell.refIds.map((id) => {
    const field = byId.get(id);
    return field?.componentId === "xform-description" &&
      /^[^\r\n]{1,4}$/u.test(String(field.props?.content || "").trim());
  });
  const shortCount = shortDescriptions.filter(Boolean).length;
  const editorCount = cell.refIds.length - shortCount;
  const shortSpan = editorCount ? Math.min(2, 12 / (shortCount || 1)) : 24 / shortCount;
  const editorSpan = editorCount ? (24 - shortCount * shortSpan) / editorCount : 0;
  return {
    type: "@elem/xform-row",
    spans: shortDescriptions.map((short) => short ? shortSpan : editorSpan),
    style: { minWidth: 0, flexWrap: "nowrap" }
  };
}

export function observeInlineCellLayout(item) {
  const row = item?.children?.length === 1 ? item.children[0] : undefined;
  if (row?.type !== "@elem/xform-row") return undefined;
  return {
    type: row.type,
    spans: row.controlProps?.spans,
    style: {
      minWidth: row.controlProps?.style?.minWidth,
      flexWrap: row.controlProps?.style?.flexWrap
    }
  };
}

/** Preserve room for editors whose physical widths come from source flow. */
export function contentFlowFieldPadding(form = {}) {
  const fields = new Map((form.fields || []).map((field) => [field.id, field]));
  const padding = new Map();
  for (const row of form.layout?.mkTree || []) {
    for (const cell of row.children || []) {
      const flow = cell.contentFlow;
      if (!flow) continue;
      for (const item of flow.items || []) {
        const field = fields.get(item.referenceId);
        if (item.width?.unit !== "px" || item.width.value <= 0 ||
            !field?.props?.hiddenLabel || !["xform-input", "xform-radio"].includes(field.componentId)) continue;
        padding.set(field.id, { top: "8px", right: "0px", bottom: "8px", left: field.props.required ? "12px" : "0px" });
        if (item.width.value > 100) continue;
        const line = flow.lines.find((ids) => ids.includes(field.id));
        if (line?.length !== 2) continue;
        const unit = fields.get(line.find((id) => id !== field.id));
        if (unit?.componentId === "xform-description" && /^[^\r\n]{1,4}$/u.test(String(unit.props?.content || "").trim())) {
          padding.set(unit.id, { top: "8px", right: "0px", bottom: "8px", left: "0px" });
        }
      }
    }
  }
  return padding;
}
