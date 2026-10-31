import { findMatchingCloseTag, isVoidLikeTag, scanHtmlTags } from "./designer-html-tokenizer.js";
import { parseStaticMarkupAttributes, staticSourceMarkup } from "./source-static-markup.js";
import { attrValue, removeRanges } from "./xml-utils.js";

const TYPES = new Map([["singleSelect", "xform:select"], ["text", "xform:xtext"],
  ["radio", "xform:radio"], ["longText", "xform:textarea"]]);
const CONDITIONAL = new Set(["c:if", "c:choose", "c:when", "c:otherwise", "xform:editshow", "xform:viewshow", "xform:right"]);

/** Add only a source fact: both editors occur in the same runtime detail cell. */
export function annotateRuntimeDetailCellEvidence(form, displayJsp) {
  const tables = (form?.fields || []).filter(table => table?.type === "detailTable" &&
    (table.columns || []).some(column => column?.source?.detailCell?.inline === true));
  if (!tables.length) return;
  const markup = staticSourceMarkup(String(displayJsp || ""));
  if (markup === undefined) return;
  const occurrences = runtimeOccurrences(markup);
  for (const table of tables) {
    const seen = new Set(), columns = table.columns || [];
    for (const column of columns) {
      const cell = column.source?.detailCell;
      if (!cell?.inline || seen.has(`${cell.row}:${cell.cell}`)) continue;
      seen.add(`${cell.row}:${cell.cell}`);
      const members = cell.fieldIds.map(id => columns.filter(item => item.id === id));
      if (members.some(matches => matches.length !== 1)) continue;
      const all = members.map(matches => matches[0]);
      const visible = all.filter(item => item.dataOnly !== true && item.source?.hardHidden !== true);
      if (visible.length !== 2 || !visible.every(item => TYPES.has(item.type)) ||
          !sameRuntimeCell(markup, occurrences, table.id, visible)) continue;
      for (const member of all) member.source = { ...member.source, detailCell: { ...member.source.detailCell, runtimeInline: true } };
    }
  }
}

function runtimeOccurrences(markup) {
  const occurrences = [], stack = [];
  for (const token of scanHtmlTags(markup)) {
    if (token.closing) {
      const index = stack.findLastIndex(item => item.name === token.name);
      if (index >= 0) stack.splice(index);
      continue;
    }
    if (token.name.startsWith("xform:")) {
      const properties = [...String(token.attrs).matchAll(/\bproperty\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu)]
        .map(match => match[1] ?? match[2] ?? match[3]);
      const attrs = parseStaticMarkupAttributes(token.attrs);
      for (const rawProperty of properties.filter(value => value.startsWith("extendDataFormInfo.value("))) {
        const cell = stack.findLast(item => item.name === "td");
        const loops = stack.filter(item => item.name === "c:foreach");
        const referenceRows = stack.filter(item => item.name === "tr" && attrValue(item.attrs, "KMSS_IsReferRow") === "1" &&
          attrValue(item.attrs, "type").toLowerCase() === "templaterow");
        let end = token.end;
        if (!token.selfClosing && !isVoidLikeTag(token.name)) {
          const close = findMatchingCloseTag(markup, token.end, token.name);
          const closing = close < 0 ? undefined : scanHtmlTags(markup, close).next().value;
          end = closing?.end ?? -1;
        }
        occurrences.push({ property: rawProperty, attrsValid: Boolean(properties.length === 1 && attrs && attrs.get("property") === rawProperty), ownHidden: hidden(token.attrs),
          type: token.name, start: token.start, end, cell: cell?.start, stack: [...stack], loops, referenceRows });
      }
    }
    if (!token.selfClosing && !isVoidLikeTag(token.name)) stack.push(token);
  }
  return occurrences;
}

function hidden(attrs) {
  return /(?:^|\s)hidden(?:\s|=|\/|$)/iu.test(String(attrs || "")) ||
    /^(?:noshow|hidden)$/iu.test(attrValue(attrs, "showStatus")) ||
    /^(?:false|0)$/iu.test(attrValue(attrs, "canShow")) ||
    /(?:^|;)\s*display\s*:\s*none\b/iu.test(attrValue(attrs, "style")) ||
    /(?:^|;)\s*visibility\s*:\s*hidden\b/iu.test(attrValue(attrs, "style")) ||
    /(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)/iu.test(attrValue(attrs, "style")) ||
    /(?:^|\s)inputhidden(?:\s|$)/iu.test(attrValue(attrs, "class"));
}

function sameRuntimeCell(markup, occurrences, tableId, fields) {
  const prefix = `extendDataFormInfo.value(${tableId}.`;
  const selected = fields.map(field => {
    const suffix = `.${field.id})`;
    return occurrences.filter(item => item.property.startsWith(prefix) && item.property.endsWith(suffix)).map(item => {
      const marker = item.property.slice(prefix.length, -suffix.length);
      const loop = /^\$\{([A-Za-z_][\w]*)\.index\}$/.exec(marker);
      const markerOk = /^\d+$/.test(marker) || marker === "!{index}" || Boolean(loop);
      const referenceOk = marker === "!{index}" ? item.referenceRows.length === 1 : item.referenceRows.length === 0;
      const conditional = item.stack.some(ancestor => CONDITIONAL.has(ancestor.name) ||
        hidden(ancestor.attrs) && !(referenceOk && marker === "!{index}" && ancestor === item.referenceRows[0]));
      let loopOk = item.loops.length === 0;
      if (loop && item.loops.length === 1) {
        const attrs = parseStaticMarkupAttributes(item.loops[0].attrs);
        loopOk = attrs?.get("varstatus") === loop[1] && attrs?.get("items") === '${_xformForm.extendDataFormInfo.formData.' + tableId + '}';
      } else if (loop) loopOk = false;
      return { ...item, marker, valid: Boolean(item.attrsValid && item.cell !== undefined && markerOk && referenceOk &&
        !conditional && loopOk && item.end >= item.start && !item.ownHidden) };
    });
  });
  if (selected.some(items => !items.length)) return false;
  const markers = selected[0].map(item => item.marker);
  if (new Set(markers).size !== markers.length || selected[1].length !== markers.length ||
      selected[1].some(item => !markers.includes(item.marker))) return false;
  return markers.every(marker => {
    const first = selected[0].find(item => item.marker === marker), second = selected[1].find(item => item.marker === marker);
    if (!first?.valid || !second?.valid || first.type !== TYPES.get(fields[0].type) || second.type !== TYPES.get(fields[1].type) ||
        first.cell !== second.cell || first.end > second.start) return false;
    const gap = markup.slice(first.end, second.start), tags = [...scanHtmlTags(gap)];
    if (tags.some(tag => tag.name === "br" || !tag.closing && (tag.name.startsWith("xform:") || tag.name.startsWith("c:")))) return false;
    return /^(?:\s|&nbsp;|&#160;|&#x0*a0;)*$/iu.test(removeRanges(gap, tags.map(tag => [tag.start, tag.end])));
  });
}
