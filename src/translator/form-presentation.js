import { componentSupportsProp } from "../dsl/catalogs.js";
import { mergeContentFlowReferences, selectContentFlow } from "../dsl/content-flow.js";

export function projectCompanionPresentation(layout, fields) {
  const dataOnlyIds = new Set(fields.filter((field) => field.dataOnly === true).map((field) => field.id));
  const replacements = new Map(fields.filter((field) => dataOnlyIds.has(field.sourceProps?.addressDisplayCompanionId))
    .map((field) => [field.sourceProps.addressDisplayCompanionId, field.id]));
  if (!replacements.size) return layout;
  return {
    ...layout,
    rows: (layout.rows || []).map((row) => ({
      ...row,
      cells: (row.cells || []).map((cell) => {
        if (!cell.contentFlow) return cell;
        const contentFlow = mergeContentFlowReferences(cell.contentFlow, replacements);
        const refs = new Map((cell.references || []).map((ref) => [ref.referenceId, ref]));
        return {
          ...cell, contentFlow,
          references: contentFlow.lines.flat().map((id) => refs.get(id))
        };
      })
    }))
  };
}

/** Unit text is consumed only after its target control can render it natively. */
export function projectUnitPresentation(form) {
  const fieldsById = new Map((form.fields || []).map((field) => [field.id, field]));
  const consumed = new Set();
  const fields = (form.fields || []).map((field) => {
    const unit = field.sourceProps?.inlineUnit;
    if (!unit?.content) return field;
    const { unit: _unit, ...props } = field.props || {};
    if (!componentSupportsProp(field.componentId, "unit")) return { ...field, props };
    const text = fieldsById.get(unit.id);
    if (text && text.componentId === "xform-description" &&
      String(text.props?.content || "").trim() === String(unit.content).trim()) {
      consumed.add(text.id);
    }
    return { ...field, props: { ...props, unit: unit.content } };
  });
  return {
    ...form,
    fields: fields.filter((field) => !consumed.has(field.id)),
    layout: {
      ...form.layout,
      mkTree: (form.layout?.mkTree || []).map((node) => ({
        ...node,
        children: (node.children || []).flatMap((cell) => {
          if (cell.refType !== "field") return [cell];
          const refIds = (cell.refIds || []).filter((id) => !consumed.has(id));
          if (!refIds.length) return [];
          return [{
            ...cell, refIds,
            ...(cell.contentFlow ? { contentFlow: selectContentFlow(cell.contentFlow, refIds) } : {})
          }];
        })
      }))
    }
  };
}
