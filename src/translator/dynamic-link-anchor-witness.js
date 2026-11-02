import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {canonicalJson} from '../agent-review/digest.js';
import {isVoidLikeTag, scanHtmlTags} from './designer-html-tokenizer.js';
import {parseStaticMarkupAttributes, staticSourceMarkup} from './source-static-markup.js';
import {parseFdValues} from './xml-utils.js';
import {inspectTruthyUrlOnlyDynamicHyperlink} from './dynamic-hyperlink.js';
import {stableSourceGlobals} from './source-dynamic-link-globals.js';

const hash = value => createHash('sha256').update(String(value || '')).digest('hex');

/** Capture source-only evidence; no target component or executable behavior is selected. */
export function dynamicLinkAnchorWitness(source, template, form) {
  const model = inspectTruthyUrlOnlyDynamicHyperlink(source);
  if (!model || !form?.layout?.rootTable || form.layout.rootTable.kind !== 'standard-table' || source.displayGate) return;
  // Authored CSS may hide or reposition the source anchor independently of
  // its inline attributes; this narrow witness does not infer CSS selectors.
  if (/<\s*(?:style|link|base)\b/i.test(template.fdDisplayJsp || '') ||
      /<\s*(?:style|link|base)\b/i.test(template.fdDesignerHtml || '')) return;
  const runtime = parseMarkup(template.fdDisplayJsp, true);
  const designer = parseMarkup(template.fdDesignerHtml, false);
  const scripts = activeScripts(template.fdDisplayJsp);
  if (!runtime || !designer || !scripts || !scripts.every(item => stableSourceGlobals(item.javascript, item.javascript === source.javascript))) return;
  const anchors = runtime.nodes.filter(node => node.attrs?.get('id') === model.containerId);
  if (anchors.length !== 1 || anchors[0].tag !== 'div' || anchors[0].attrs.size !== 1 || anchors[0].closeStart === undefined ||
      runtime.markup.slice(anchors[0].end, anchors[0].closeStart).trim() || gated(anchors[0])) return;
  const cell = ancestor(anchors[0], 'td');
  const root = ancestor(anchors[0], 'table');
  const rowNode = ancestor(anchors[0], 'tr');
  const row = Number(cell?.attrs?.get('row'));
  const columns = cell?.attrs?.get('column');
  const runtimeId = root?.attrs?.get('id');
  if (!cell || !root || !rowNode || !runtimeId || ancestor(root, 'table') ||
      runtime.nodes.filter(node => node.tag === 'table' && node.attrs?.get('id') === runtimeId).length !== 1 ||
      !Number.isInteger(row) || row < 0 || row >= form.layout.rootTable.rowCount ||
      !/^\d+(?:,\d+)*$/.test(columns || '')) return;
  const column = Number(columns.split(',')[0]);
  const designerRoots = designer.nodes.filter(node => node.tag === 'table' && node.attrs?.get('id') === runtimeId);
  if (designerRoots.length !== 1 || ancestor(designerRoots[0], 'table')) return;
  const designerRoot = designerRoots[0];
  const matchingCells = designer.nodes.filter(node => node.tag === 'td' && node.attrs?.get('row') === String(row) &&
    node.attrs?.get('column') === columns && ancestor(node, 'table') === designerRoot);
  if (matchingCells.length !== 1 || gated(matchingCells[0])) return;
  const designerRow = ancestor(matchingCells[0], 'tr');
  const runtimeGrid = grid(runtime, root, rowNode, cell, form.layout.rootTable.rowCount);
  const designerGrid = grid(designer, designerRoot, designerRow, matchingCells[0], form.layout.rootTable.rowCount);
  if (!runtimeGrid || !designerGrid || canonicalJson(runtimeGrid) !== canonicalJson(designerGrid) ||
      runtimeGrid.row !== row || runtimeGrid.column !== column) return;
  let fragment;
  if (source.sourceType === 'designer-jsp') {
    const fragments = designer.nodes.filter(node => node.attrs?.get('id') === source.fragmentId);
    if (fragments.length !== 1 || ancestor(fragments[0], 'td') !== matchingCells[0] || gated(fragments[0])) return;
    fragment = fragments[0];
  } else if (source.sourceType !== 'display-jsp') return;
  const matchingScripts = scripts.filter(item => item.javascript === source.javascript);
  if (matchingScripts.length !== 1 || cell.closeStart === undefined || matchingScripts[0].start < cell.start ||
      matchingScripts[0].start >= cell.closeStart || scriptGated(runtime, matchingScripts[0].start)) return;
  const affectedIds = new Set([model.sourceUrlFieldId, `extendDataFormInfo.value(${model.sourceUrlFieldId})`]);
  for (let node = anchors[0]; node; node = node.parent) {
    for (const key of ['id', 'name']) if (node.attrs?.get(key)) affectedIds.add(node.attrs.get(key));
  }
  if (!scripts.every(item => noAffectedRowHelper(item.javascript, affectedIds))) return;
  if (!closedRow(runtime, rowNode, anchors[0], model.sourceUrlFieldId, undefined, 'runtime') ||
      !closedRow(designer, designerRow, undefined, model.sourceUrlFieldId, fragment, 'designer')) return;
  const payload = {
    version: 1, sourceRef: source.sourceRef || source.id, sourceJavascriptSha256: hash(source.javascript),
    runtimeHtmlSha256: hash(template.fdDisplayJsp), designerHtmlSha256: hash(template.fdDesignerHtml),
    containerId: model.containerId, row, column, columns, gridColumns:runtimeGrid.gridColumns,
    cellSpan:runtimeGrid.cellSpan, fragmentId: source.fragmentId || null,
    sourceType: source.sourceType, runtimeScriptMatches: 1,
    runtimeScriptHashes: scripts.map(item => hash(item.javascript))
  };
  return {...payload, witnessSha256:hash(canonicalJson(payload))};
}

function noAffectedRowHelper(source, affectedIds) {
  let safe = true;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee?.name === 'common_dom_row_set_show_required_reset') {
      const argument = node.arguments?.[0];
      if (argument?.type !== 'Literal' || typeof argument.value !== 'string' || affectedIds.has(argument.value)) safe = false;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  try { walk(parse(source, {ecmaVersion:'latest'})); } catch { return false; }
  return safe;
}

export function validDynamicLinkAnchorWitness(witness, source, evidence) {
  if (!witness || witness.version !== 1 || witness.sourceRef !== (source?.sourceRef || source?.id) ||
      witness.sourceJavascriptSha256 !== hash(source?.javascript) || witness.containerId !== evidence?.containerId ||
      !Number.isInteger(witness.row) || witness.row < 0 || !Number.isInteger(witness.column) || witness.column < 0 ||
      !Number.isInteger(witness.gridColumns) || witness.gridColumns < 1 || !Number.isInteger(witness.cellSpan) ||
      witness.cellSpan < 1 || witness.column + witness.cellSpan > witness.gridColumns ||
      typeof witness.columns !== 'string' || !/^\d+(?:,\d+)*$/.test(witness.columns) ||
      witness.columns !== Array.from({length:witness.cellSpan}, (_, i) => witness.column + i).join(',') ||
      witness.runtimeScriptMatches !== 1 || witness.sourceType !== source.sourceType ||
      witness.fragmentId !== (source.fragmentId || null) ||
      !Array.isArray(witness.runtimeScriptHashes) || !witness.runtimeScriptHashes.length ||
      witness.runtimeScriptHashes.some(value => !/^[a-f0-9]{64}$/.test(value)) ||
      !/^[a-f0-9]{64}$/.test(witness.runtimeHtmlSha256 || '') || !/^[a-f0-9]{64}$/.test(witness.designerHtmlSha256 || '')) return false;
  const {witnessSha256, ...payload} = witness;
  return witnessSha256 === hash(canonicalJson(payload));
}

function grid(parsed, root, targetRow, targetCell, expectedRows) {
  const rows = parsed.nodes.filter(node => node.tag === 'tr' && ancestor(node, 'table') === root);
  if (rows.length !== expectedRows || rows.indexOf(targetRow) < 0) return;
  let width;
  for (const [index, row] of rows.entries()) {
    const cells = parsed.nodes.filter(node => ['td','th'].includes(node.tag) && ancestor(node, 'tr') === row && ancestor(node, 'table') === root);
    let offset = 0;
    for (const cell of cells) {
      if (!cell.attrs || cell.attrs.get('row') !== String(index)) return;
      const span = Number(cell.attrs.get('colspan') || '1');
      if (!Number.isInteger(span) || span < 1 || Number(cell.attrs.get('rowspan') || '1') !== 1 ||
          cell.attrs.get('column') !== Array.from({length:span}, (_, i) => offset + i).join(',')) return;
      if (cell === targetCell && (index !== Number(targetCell.attrs.get('row')) || offset !== Number(targetCell.attrs.get('column').split(',')[0]))) return;
      offset += span;
    }
    if (!offset || (width !== undefined && width !== offset)) return;
    width = offset;
  }
  const span = Number(targetCell.attrs.get('colspan') || '1');
  return {row:rows.indexOf(targetRow),column:Number(targetCell.attrs.get('column').split(',')[0]),cellSpan:span,gridColumns:width};
}

function closedRow(parsed, row, anchor, urlFieldId, fragment, surface) {
  if (!row || row.closeEnd === undefined) return false;
  const descendants = parsed.nodes.filter(node => isWithin(node, row));
  const hidden = descendants.filter(node => node.tag === 'div' && node.attrs && (
    surface === 'runtime' ? /(?:^|;)\s*display\s*:\s*none/i.test(node.attrs.get('style') || '')
      : node.attrs.get('canshow') === 'false'
  ));
  if (hidden.length > 1) return false;
  if (hidden.length) {
    const node = hidden[0], values = parseFdValues(node.attrs.get('fd_values') || '');
    const childNodes = descendants.filter(child => isWithin(child, node));
    const runtimeField = childNodes.filter(child => child.tag === 'xform:xtext' && child.attrs?.get('property') === `extendDataFormInfo.value(${urlFieldId})`);
    const designerField = values.id === urlFieldId && values.canShow === 'false' && values.dataType === 'String';
    if (surface === 'runtime' && (runtimeField.length !== 1 || childNodes.length !== 1)) return false;
    if (surface === 'runtime' && ([...runtimeField[0].attrs.keys()].some(key => !['property','style','required','showstatus','subject','title','onvaluechange'].includes(key)) ||
        !safeVisibleStyle(runtimeField[0].attrs.get('style') || '') ||
        (runtimeField[0].attrs.has('onvaluechange') && runtimeField[0].attrs.get('onvaluechange') !== '__xformDispatch'))) return false;
    if (surface === 'designer' && (!designerField || childNodes.some(child => child.tag !== 'input' || !child.attrs || [...child.attrs.keys()].some(key => key.startsWith('on'))))) return false;
    if (node.closeStart === undefined || parsed.markup.slice(node.end, node.closeStart).replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#x0*a0;/gi, '').trim()) return false;
  }
  const ignored = [anchor, fragment, ...hidden].filter(Boolean);
  if (ignored.some(node => node.closeEnd === undefined)) return false;
  for (const node of descendants) {
    if (['td','th'].includes(node.tag) || ignored.some(parent => node === parent || isWithin(node, parent))) continue;
    return false;
  }
  let text = parsed.markup.slice(row.start, row.closeEnd);
  for (const node of ignored.sort((a,b)=>b.start-a.start)) {
    const start = node.start - row.start, end = node.closeEnd - row.start;
    text = text.slice(0,start) + ' '.repeat(end-start) + text.slice(end);
  }
  text = text.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#x0*a0;/gi, '').trim();
  return text === '';
}
function isWithin(node, parent) {
  for (let current = node?.parent; current; current = current.parent) if (current === parent) return true;
  return false;
}
function ancestor(node, tag) {
  for (let current = node?.parent; current; current = current.parent) if (current.tag === tag) return current;
}
function gated(node) {
  for (let current = node; current; current = current.parent) {
    const attrs = current.attrs;
    if (!attrs || current.tag.includes(':') || attrs.has('hidden') || attrs.has('inert') || attrs.has('popover') || [...attrs.keys()].some(key => key.startsWith('on')) || !safeVisibleStyle(attrs.get('style') || '') ||
        /\$\{|<%/.test(attrs.get('id') || '')) return true;
  }
  return false;
}
function scriptGated(parsed, position) {
  return parsed.nodes.some(node => node.start < position && node.closeStart !== undefined && position < node.closeStart &&
    (node.tag.includes(':') || !node.attrs || node.attrs.has('hidden') || node.attrs.has('inert') || node.attrs.has('popover') || !safeVisibleStyle(node.attrs.get('style') || '')));
}
function safeVisibleStyle(style) {
  if (!style) return true;
  if (/\/\*|\*\/|\\|[{}]/.test(style)) return false;
  const safeNames = /^(?:width|height|vertical-align|text-align|display)$/i;
  return style.split(';').filter(part => part.trim()).every(part => {
    const match = /^\s*([a-z-]+)\s*:\s*([^:]+)\s*$/i.exec(part);
    if (!match || !safeNames.test(match[1]) || /(?:url\s*\(|expression\s*\(|var\s*\()/i.test(match[2])) return false;
    const name = match[1].toLowerCase(), value = match[2].trim();
    if (name === 'display') return /^(?:inline|block|inline-block|table|table-row|table-cell)$/i.test(value);
    if (name === 'width' || name === 'height') return value.toLowerCase() === 'auto' || /^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)(?:px|%|em|rem)$/i.test(value);
    return /^(?:left|right|center|top|middle|bottom|baseline)$/i.test(value);
  });
}
function parseMarkup(html, strict) {
  if (typeof html !== 'string' || !html) return;
  const markup = staticSourceMarkup(html);
  if (markup === undefined) return;
  const nodes = [], stack = [];
  for (const token of scanHtmlTags(markup)) {
    if (token.closing) {
      const index = stack.findLastIndex(item => item.tag === token.name);
      if (index >= 0) {stack[index].closeStart = token.start; stack[index].closeEnd = token.end; stack.splice(index);}
      continue;
    }
    const attrs = parseStaticMarkupAttributes(token.attrs) || (!strict && token.name === 'input'
      ? parseStaticMarkupAttributes(token.attrs.replace(/(^|\s)\?(?=\s|$)/g, '$1')) : undefined);
    if (strict && !attrs) return;
    if (attrs && /\$\{|<%/.test(attrs.get('id') || '')) return;
    const node = {tag:token.name,start:token.start,end:token.end,attrs,parent:stack.at(-1)};
    nodes.push(node);
    if (!token.selfClosing && !isVoidLikeTag(token.name)) stack.push(node);
  }
  return {markup,nodes};
}
function activeScripts(html) {
  if (typeof html !== 'string') return;
  let masked = html;
  for (const [open, close] of [['<!--','-->'], ['<%--','--%>']]) {
    let start = 0, index;
    while ((index = masked.indexOf(open, start)) >= 0) {
      const end = masked.indexOf(close, index + open.length);
      if (end < 0) return;
      const stop = end + close.length;
      masked = masked.slice(0,index) + masked.slice(index,stop).replace(/[^\r\n]/g,' ') + masked.slice(stop);
      start = stop;
    }
  }
  const scripts = [];
  let skip = 0;
  for (const token of scanHtmlTags(masked)) {
    if (token.start < skip || token.closing) continue;
    if (!['script','style','textarea','xform:textarea','pre','code'].includes(token.name)) continue;
    if (token.selfClosing) { if (token.name === 'script') return; continue; }
    const close = new RegExp(`<\\/\\s*${token.name}\\s*>`, 'ig');
    close.lastIndex = token.end;
    const end = close.exec(masked);
    if (!end) return;
    skip = close.lastIndex;
    if (token.name !== 'script') continue;
    const attrs = parseStaticMarkupAttributes(token.attrs);
    if (!attrs || [...attrs.keys()].some(key => !['type','language'].includes(key)) ||
        (attrs.has('type') && !['text/javascript','application/javascript','text/ecmascript','application/ecmascript'].includes(attrs.get('type').toLowerCase())) ||
        (attrs.has('language') && attrs.get('language').toLowerCase() !== 'javascript')) return;
    let javascript = masked.slice(token.end,end.index).replace(/\r\n?/g,'\n').trim();
    if (javascript) scripts.push({start:token.start,javascript});
  }
  return scripts;
}
