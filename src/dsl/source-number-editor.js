import { sourceRequiresReadOnly } from './source-readonly.js';

const positivePx = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/u.exec(String(value));
  const number = match && Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = value => typeof value === 'string' && value.trim() !== '' && !/[<>\r\n]/u.test(value);
const decorated = object => Object.entries(object || {}).some(([key, value]) =>
  /prefix|suffix/i.test(key) && value !== undefined && value !== null && value !== '');

/** Source inputText value width and cell-shell width are separate facts. No target sizing policy is public DSL. */
export function sourceNumberEditors(form = {}) {
  const target = Array.isArray(form.fields);
  const main = target ? form.fields.filter(field => field.type !== 'detailTable') : [...(form.controls || []), ...(form.dataFields || [])];
  const all = target ? form.fields.flatMap(field => [field, ...(field.columns || [])]) : [...main, ...(form.detailTables || []).flatMap(table => [table, ...(table.columns || [])])];
  const sourceCells = (target ? form.layout?.sourceGrid?.rows : form.layout?.rows)?.flatMap(row => row.cells || []) || [];
  const targetCells = target ? (form.layout?.mkTree || []).flatMap(row => row.children || []) : sourceCells;
  const profiles = new Map();
  for (const field of main) {
    const source = field.sourceProps || {}, values = source.designerValues || {};
    if ((target ? field.type !== 'number' || field.componentId !== 'xform-number' : field.sourceType !== 'number') ||
        source.designerType !== 'inputText' || values.dataType !== 'Double' || source.layoutCell?.hiddenLabel !== true ||
        (target && field.props?.hiddenLabel !== true) || field.dataOnly === true || field.props?.readOnly === true ||
        field.props?.calculation !== undefined || sourceRequiresReadOnly(field) ||
        decorated(source) || decorated(values) || decorated(field.props)) continue;
    const inputPx = positivePx(values.width);
    if (inputPx === undefined || !field.sourceRef || source.designerId !== field.id || values.id !== field.id ||
        all.filter(item => item.id === field.id || item.sourceRef === field.sourceRef).length !== 1) continue;
    // Fully absent metadata is supported by the typed Designer. Partial or conflicting metadata is not evidence.
    if (['metadataId', 'metadataKind', 'metadataAttributes'].some(key => source[key] !== undefined) &&
        (source.metadataId !== field.id || source.metadataKind !== 'simple' || source.metadataAttributes?.name !== field.id ||
         source.metadataAttributes?.type !== 'Double' || source.metadataAttributes?.kind !== 'simple')) continue;
    const cells = sourceCells.filter(cell => (cell.references || []).some(ref => ref.referenceId === field.id));
    if (cells.length !== 1) continue;
    const cell = cells[0], flow = cell.contentFlow;
    const refs = (cell.references || []).filter(ref => ref.referenceId === field.id);
    const items = (flow?.items || []).filter(item => item.referenceId === field.id);
    if (refs.length !== 1 || refs[0].referenceType !== 'control' || refs[0].sourceRef !== field.sourceRef ||
        items.length !== 1 || items[0].width?.unit !== 'px' || !Number.isFinite(items[0].width.value) || items[0].width.value <= 0 ||
        (flow?.lines || []).flat().filter(id => id === field.id).length !== 1) continue;
    const actualCells = targetCells.filter(candidate => (target ? candidate.refIds : (candidate.references || []).map(ref => ref.referenceId))?.includes(field.id));
    if (actualCells.length !== 1 || actualCells[0].sourceRef !== cell.sourceRef) continue;
    const actualFlow = actualCells[0].contentFlow;
    if (!actualFlow || actualFlow.items.filter(item => item.referenceId === field.id).length !== 1 ||
        !same(actualFlow.items.find(item => item.referenceId === field.id)?.width, items[0].width) ||
        actualFlow.lines.flat().filter(id => id === field.id).length !== 1) continue;
    const unit = source.inlineUnit;
    if (unit !== undefined) {
      const texts = main.filter(text => text.id === unit.id);
      const text = texts[0], textSource = text?.sourceProps;
      const line = flow.lines.find(line => line.includes(field.id));
      const actualLine = actualFlow.lines.find(line => line.includes(field.id));
      if (unit.relation !== 'immediately-adjacent-plain-text-in-same-cell' || !plain(unit.content) ||
          texts.length !== 1 || !text?.sourceRef || all.filter(item => item.sourceRef === text.sourceRef).length !== 1 ||
          (target ? text.componentId !== 'xform-description' || text.props?.content !== unit.content : text.sourceType !== 'description') ||
          textSource?.designerId !== text.id || textSource?.designerType !== 'textLabel' || textSource?.designerValues?.id !== text.id ||
          textSource?.designerValues?.content !== unit.content ||
          sourceCells.filter(cell => (cell.references || []).some(ref => ref.referenceId === unit.id)).length !== 1 ||
          cell.references.filter(ref => ref.referenceId === unit.id && ref.sourceRef === text.sourceRef).length !== 1 ||
          flow.items.filter(item => item.referenceId === unit.id).length !== 1 || flow.lines.flat().filter(id => id === unit.id).length !== 1 ||
          line[line.indexOf(field.id) + 1] !== unit.id || actualLine[actualLine.indexOf(field.id) + 1] !== unit.id ||
          actualFlow.lines.flat().filter(id => id === unit.id).length !== 1) continue;
    }
    profiles.set(field.id, { inputPx, sourceOuterPx: items[0].width.value, sourceRef: field.sourceRef, cellSourceRef: cell.sourceRef,
      ...(unit ? { unitId: unit.id } : {}) });
  }
  return profiles;
}
