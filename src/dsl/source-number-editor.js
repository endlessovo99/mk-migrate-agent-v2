import { canonicalJson } from "../agent-review/digest.js";
import { sourceRequiresReadOnly } from './source-readonly.js';

const positivePx = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/u.exec(String(value));
  const number = match && Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const plain = value => typeof value === 'string' && value.trim() !== '' && !/[<>\r\n]/u.test(value);
const decorated = object => Object.entries(object || {}).some(([key, value]) =>
  /prefix|suffix/i.test(key) && value !== undefined && value !== null && value !== '');

/** Source inputText value width and cell-shell width are separate facts. No target sizing policy is public DSL. */
export function sourceNumberEditors(form = {}) {
  const context = numericWidthContext(form);
  const { target, main } = context;
  const profiles = new Map();
  for (const field of main) {
    const source = field.sourceProps || {}, values = source.designerValues || {};
    if ((target ? field.type !== 'number' || field.componentId !== 'xform-number' : field.sourceType !== 'number') ||
        source.designerType !== 'inputText' || values.dataType !== 'Double' || source.layoutCell?.hiddenLabel !== true ||
        (target && field.props?.hiddenLabel !== true && !field.sourceProps?.foldedCaption) || field.dataOnly === true || field.props?.readOnly === true ||
        field.props?.calculation !== undefined || sourceRequiresReadOnly(field) ||
        decorated(source) || decorated(values) || decorated(field.props)) continue;
    const profile = sourceWidthProfile(field, context);
    if (profile) profiles.set(field.id, profile);
  }
  return profiles;
}

/** Readonly value-width evidence has its own scope; it never enables editor behavior. */
export function sourceNumberDisplays(form = {}) {
  const context = numericWidthContext(form), { target, main } = context;
  const profiles = new Map();
  for (const field of main) {
    const source = field.sourceProps || {}, values = source.designerValues || {};
    const evidence = source.runtimeNumberDisplayWidth, width = positivePx(values.width);
    if ((target ? field.type !== 'number' || !['xform-number', 'xform-calculate'].includes(field.componentId) : field.sourceType !== 'number') ||
        !['inputText', 'calculation'].includes(source.designerType) || values.dataType !== 'Double' ||
        String(values.readOnly).trim().toLowerCase() !== 'true' || source.layoutCell?.hiddenLabel !== true ||
        target && (field.props?.hiddenLabel !== true && !field.sourceProps?.foldedCaption || field.props?.readOnly !== true) || field.dataOnly === true ||
        displayDecorated(source) || displayDecorated(field.props) ||
        source.metadataId !== field.id || source.metadataKind !== 'simple' ||
        source.metadataAttributes?.name !== field.id || source.metadataAttributes?.type !== 'Double' ||
        source.metadataAttributes?.kind !== 'simple' ||
        Object.hasOwn(source.metadataAttributes || {}, 'width') && positivePx(source.metadataAttributes.width) !== width ||
        !evidence || evidence.source !== 'fdDisplayJsp' || evidence.renderer !== 'xform:xtext' ||
        evidence.property !== `extendDataFormInfo.value(${field.id})` || evidence.readOnly !== true ||
        !Number.isInteger(evidence.offset) || evidence.offset < 0 || evidence.valuePx !== width) continue;
    const profile = sourceWidthProfile(field, context);
    if (profile && profile.inputPx === profile.sourceOuterPx) profiles.set(field.id, profile);
  }
  return profiles;
}

function displayDecorated(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    (/prefix|suffix/i.test(key) || key.toLowerCase() === 'unit') &&
      child !== undefined && child !== null && child !== '' || displayDecorated(child));
}

function numericWidthContext(form) {
  const target = Array.isArray(form.fields);
  const main = target ? form.fields.filter(field => field.type !== 'detailTable') : [...(form.controls || []), ...(form.dataFields || [])];
  const all = target ? form.fields.flatMap(field => [field, ...(field.columns || [])]) : [...main, ...(form.detailTables || []).flatMap(table => [table, ...(table.columns || [])])];
  const sourceCells = (target ? form.layout?.sourceGrid?.rows : form.layout?.rows)?.flatMap(row => row.cells || []) || [];
  const targetCells = target ? (form.layout?.mkTree || []).flatMap(row => row.children || []) : sourceCells;
  return { target, main, all, sourceCells, targetCells };
}

function sourceWidthProfile(field, context) {
  const { target, main, all, sourceCells, targetCells } = context;
  const source = field.sourceProps || {}, values = source.designerValues || {};
  const inputPx = positivePx(values.width);
  if (inputPx === undefined || !field.sourceRef || source.designerId !== field.id || values.id !== field.id ||
      all.filter(item => item.id === field.id || item.sourceRef === field.sourceRef).length !== 1) return undefined;
  // Fully absent metadata is supported by the typed Designer. Partial or conflicting metadata is not evidence.
  if (['metadataId', 'metadataKind', 'metadataAttributes'].some(key => source[key] !== undefined) &&
      (source.metadataId !== field.id || source.metadataKind !== 'simple' || source.metadataAttributes?.name !== field.id ||
       source.metadataAttributes?.type !== 'Double' || source.metadataAttributes?.kind !== 'simple')) return undefined;
  const cells = sourceCells.filter(cell => (cell.references || []).some(ref => ref.referenceId === field.id));
  if (cells.length !== 1) return undefined;
  const cell = cells[0], flow = cell.contentFlow;
  const refs = (cell.references || []).filter(ref => ref.referenceId === field.id);
  const items = (flow?.items || []).filter(item => item.referenceId === field.id);
  if (refs.length !== 1 || refs[0].referenceType !== 'control' || refs[0].sourceRef !== field.sourceRef ||
      items.length !== 1 || items[0].width?.unit !== 'px' || !Number.isFinite(items[0].width.value) || items[0].width.value <= 0 ||
      (flow?.lines || []).flat().filter(id => id === field.id).length !== 1) return undefined;
  const actualCells = targetCells.filter(candidate => (target ? candidate.refIds : (candidate.references || []).map(ref => ref.referenceId))?.includes(field.id));
  if (actualCells.length !== 1 || actualCells[0].sourceRef !== cell.sourceRef) return undefined;
  const actualFlow = actualCells[0].contentFlow;
  if (!actualFlow || actualFlow.items.filter(item => item.referenceId === field.id).length !== 1 ||
      !same(actualFlow.items.find(item => item.referenceId === field.id)?.width, items[0].width) ||
      actualFlow.lines.flat().filter(id => id === field.id).length !== 1) return undefined;
  const line = flow.lines.find(ids => ids.includes(field.id));
  const numericPeers = line.map(id => main.find(item => item.id === id))
    .filter(item => item && (target ? item.type === 'number' : item.sourceType === 'number'));
  // A partial number/text/number group can be a range separator, not a unit suffix.
  // Keep the existing native presentation unless every number has its own adjacent unit.
  if (numericPeers.length > 1 && numericPeers.some(peer =>
    !peer.sourceProps?.inlineUnit || line[line.indexOf(peer.id) + 1] !== peer.sourceProps.inlineUnit.id)) return undefined;
  const unit = source.inlineUnit;
  if (unit !== undefined) {
    const texts = main.filter(text => text.id === unit.id);
    const text = texts[0], textSource = text?.sourceProps;
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
        actualFlow.lines.flat().filter(id => id === unit.id).length !== 1) return undefined;
  }
  return { inputPx, sourceOuterPx: items[0].width.value, sourceRef: field.sourceRef, cellSourceRef: cell.sourceRef,
    ...(unit ? { unitId: unit.id } : {}) };
}
