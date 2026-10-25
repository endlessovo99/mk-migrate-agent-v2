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
      const captionPadding = adaptiveCaptionPadding(form, row, cell, fields);
      if (captionPadding) padding.set(cell.refIds[0], captionPadding);
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

function adaptiveCaptionPadding(form, row, cell, fields) {
  const flow = cell.contentFlow;
  if (form.layout?.sizing !== "adaptive" || !(row.props?.columns > 1) ||
      cell.refType !== "field" || cell.refIds?.length !== 1 || cell.colspan !== 1 ||
      !Number.isInteger(cell.column) || cell.column < 0 ||
      flow.lines?.length !== 1 || flow.lines[0]?.length !== 1 || flow.items?.length !== 1) return undefined;
  const id = cell.refIds[0], item = flow.items[0], field = fields.get(id);
  if (item.referenceId !== id || flow.lines[0][0] !== id || item.width?.unit !== "px" ||
      !Number.isFinite(item.width.value) || item.width.value <= 0 ||
      field?.componentId !== "xform-description" || field.dataOnly ||
      typeof field.props?.content !== "string" || !field.props.content.trim() ||
      /[\r\n\t<>]/u.test(field.props.content) || field.props.hasLink === true || field.props.link) return undefined;
  // A standalone title has one immediately adjacent, separately rendered text
  // input. Do not infer this role from source audit metadata or field names.
  const neighbors = row.children.filter(next => next.column === cell.column + 1 &&
    (next.row || 0) === (cell.row || 0) && next.refType === "field" && next.refIds?.length === 1);
  if (neighbors.length !== 1) return undefined;
  const editor = fields.get(neighbors[0].refIds[0]);
  if (editor?.componentId !== "xform-input" || editor.dataOnly || editor.props?.hiddenLabel !== true ||
      editor.title !== field.props.content) return undefined;
  // The classic native wrapper retains its 16px left inset even when a custom
  // paddingControl is supplied. Reduce only the effective right inset toward a
  // 20% declared-px budget; below 80px, the left inset is the attainable floor.
  const right = Math.max(0, Math.min(16, Math.floor(item.width.value * 0.2) - 16));
  if (right === 16) return undefined;
  return { top: "8px", right: `${right}px`, bottom: "8px", left: "16px" };
}
