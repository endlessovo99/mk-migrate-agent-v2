import { canonicalJson } from "../agent-review/digest.js";
import { sourceRequiresReadOnly } from "./source-readonly.js";

const METADATA_KEYS = new Set(["name", "label", "type", "length", "notNull", "kind", "defaultValue"]);
const plain = value => typeof value === "string" && value.trim() && !/[<>\r\n]/.test(value);
const px = value => {
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(String(value ?? ""));
  const number = match && Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};
const decorated = object => Object.entries(object || {}).some(([key, value]) =>
  /prefix|suffix|unit/i.test(key) && value !== undefined && value !== null && value !== "");

/** Fixed SourceDraft widget width; native label/padding budgets stay private. */
export function sourceInlineEditorWidths(form = {}) {
  const target = Array.isArray(form.fields);
  const main = target ? form.fields.filter(field => field.type !== "detailTable") : [...form.controls || [], ...form.dataFields || []];
  const all = target ? form.fields.flatMap(field => [field, ...field.columns || []]) :
    [...main, ...(form.detailTables || []).flatMap(table => [table, ...table.columns || []])];
  const cells = (target ? form.layout?.sourceGrid?.rows : form.layout?.rows)?.flatMap(row => row.cells || []) || [];
  const actualCells = target ? (form.layout?.mkTree || []).flatMap(row => row.children || []) : cells;
  const result = new Map();
  for (const field of main) {
    const source = field.sourceProps || {}, values = source.designerValues || {}, metadata = source.metadataAttributes || {};
    const type = target ? field.type : field.sourceType, inputPx = px(values.width);
    const text = type === "text" && source.designerType === "inputText" && values.dataType === "String" &&
      (!target || field.componentId === "xform-input");
    const date = type === "dateTime" && source.designerType === "datetime" && values.businessType === "dateDialog" &&
      (!target || field.componentId === "xform-datetime");
    if ((!text && !date) || !inputPx || !field.sourceRef || !/^[A-Za-z_][\w-]*$/.test(field.id || "") ||
        source.designerId !== field.id || values.id !== field.id ||
        all.filter(item => item.id === field.id || item.sourceRef === field.sourceRef).length !== 1 ||
        field.dataOnly === true || field.props?.hiddenLabel === true || source.layoutCell?.hiddenLabel === true ||
        field.props?.readOnly === true || sourceRequiresReadOnly(field) || field.props?.calculation !== undefined ||
        String(values.readOnly).trim().toLowerCase() !== "false" || String(values.canShow).trim().toLowerCase() !== "true" ||
        values._label_bind !== "false" || values._label_bind_id || values.formula ||
        source.inlineCaption?.relation !== "leading-unbound-subject-caption" ||
        source.subjectLabel?.relation !== "unbound-control-subject-distinct-from-visible-caption" ||
        !plain(field.title) || field.title !== source.inlineCaption.content ||
        !plain(source.inlineCaption.id) || !plain(values.label) || source.subjectLabel.content !== values.label ||
        source.metadataId !== field.id || source.metadataKind !== "simple" || metadata.name !== field.id ||
        metadata.kind !== "simple" || metadata.type !== (text ? "String" : "Date") || metadata.label !== values.label ||
        Object.keys(metadata).some(key => !METADATA_KEYS.has(key)) ||
        decorated(field.props) || decorated(source) || decorated(values)) continue;
    const sourceCells = cells.filter(cell => (cell.references || []).some(ref => ref.referenceId === field.id));
    if (sourceCells.length !== 1) continue;
    const cell = sourceCells[0], flow = cell.contentFlow;
    const refs = (cell.references || []).filter(ref => ref.referenceId === field.id);
    const items = (flow?.items || []).filter(item => item.referenceId === field.id);
    if (refs.length !== 1 || refs[0].referenceType !== "control" || refs[0].sourceRef !== field.sourceRef ||
        !Array.isArray(flow?.lines) || flow.lines.some(line => !Array.isArray(line)) ||
        items.length !== 1 || items[0].width?.unit !== "px" || !Number.isFinite(items[0].width.value) ||
        items[0].width.value < inputPx || flow.lines.flat().filter(id => id === field.id).length !== 1) continue;
    const actual = actualCells.filter(candidate => (target ? candidate.refIds : (candidate.references || []).map(ref => ref.referenceId))?.includes(field.id));
    if (actual.length !== 1 || actual[0].sourceRef !== cell.sourceRef || canonicalJson(actual[0].contentFlow) !== canonicalJson(flow)) continue;
    result.set(field.id, {
      sourceRef: field.sourceRef, cellSourceRef: cell.sourceRef, inputPx, sourceOuterPx: items[0].width.value,
      // Classic-standard PC label: 8em@14px + padding32 + border1; control padding32 is separate.
      nativeOuterPx: inputPx + 8 * 14 + 32 + 1 + 32
    });
  }
  return result;
}
