import { scanHtmlTags } from "./designer-html-tokenizer.js";
import { parseStaticMarkupAttributes, staticSourceMarkup } from "./source-static-markup.js";

/** Evidence for the explicit closed root-table/direct-TR route only. The
 * permissive whole-HTML and regex fallback parsers never establish this fact. */
export function rootTableEvidence(html, selectedRows) {
  const markup = staticSourceMarkup(html);
  if (markup === undefined) return undefined;
  const tokens = [...scanHtmlTags(markup)], tables = [], stack = [];
  let root;
  for (const token of tokens) {
    // These less common raw-text elements are outside staticSourceMarkup's
    // supported source domain. Their contents cannot establish a table fact.
    if (["title", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript", "template"].includes(token.name)) return undefined;
    if (token.name !== "table") continue;
    if (token.closing) {
      const open = stack.pop();
      if (!open) return undefined;
      if (!stack.length) tables.push({ open, close: token });
    } else {
      const attrs = parseStaticMarkupAttributes(token.attrs);
      if (!attrs || token.selfClosing) return undefined;
      if (!stack.length && attrs.get("fd_type")?.toLowerCase() === "standardtable") {
        if (root) return undefined;
        root = token;
      }
      stack.push(token);
    }
  }
  if (stack.length || !root || tables.length !== 1 || tables[0].open !== root) return undefined;
  const { close } = tables[0];
  const body = tokens.filter(token => token.start >= root.end && token.end <= close.start);
  const rows = strictDirectRows(html, body, selectedRows.length);
  if (!rows?.length || rows.length !== selectedRows.length ||
      rows.some((row, index) => row !== selectedRows[index])) return undefined;
  return { version: 1, kind: "standard-table", rowCount: rows.length };
}

function strictDirectRows(html, tokens, rowCount) {
  const rows = [];
  const occupied = new Map();
  let cursor = 0, cellIndex = 0;
  let tbody = false, bodyCount = 0, row, cell, nestedTables = 0;
  for (const token of tokens) {
    if (cell) {
      if (token.name === "table") nestedTables += token.closing ? -1 : 1;
      if (nestedTables < 0) return undefined;
      if (!nestedTables && ["td", "th", "tr", "tbody", "thead", "tfoot", "colgroup", "col"].includes(token.name)) {
        if (token.name !== cell || !token.closing) return undefined;
        cell = undefined;
      }
      // Only direct TR/TD parentage is proved; content inside cells stays under
      // the existing control parser, including nested tables.
      continue;
    }
    if (row) {
      if (["td", "th"].includes(token.name) && !token.closing && !token.selfClosing) {
        const attrs = parseStaticMarkupAttributes(token.attrs);
        if (!attrs) return undefined;
        const colspan = attrs.get("colspan") ?? "1", rowspan = attrs.get("rowspan") ?? "1";
        if (!/^[1-9]\d*$/.test(colspan) || !/^[1-9]\d*$/.test(rowspan) ||
            !Number.isSafeInteger(Number(colspan)) || !Number.isSafeInteger(Number(rowspan)) ||
            rows.length + Number(rowspan) > rowCount) return undefined;
        const declared = attrs.get("column") ?? String(cellIndex);
        if (!/^\d+(?:\s*,\s*\d+)*$/.test(declared)) return undefined;
        const columns = declared.split(",").map(Number);
        while ((occupied.get(cursor) || 0) > rows.length) cursor++;
        if (columns.length !== Number(colspan) || columns.some((column, index) =>
          !Number.isSafeInteger(column) || column !== cursor + index || (occupied.get(column) || 0) > rows.length)) return undefined;
        for (const column of columns) occupied.set(column, rows.length + Number(rowspan));
        cursor += columns.length; cellIndex++;
        cell = token.name;
      }
      else if (token.name === "tr" && token.closing) { rows.push(html.slice(row.start, token.end)); row = undefined; }
      else return undefined;
      continue;
    }
    if (token.name === "tbody" && !token.selfClosing) {
      if (token.closing) { if (!tbody) return undefined; tbody = false; }
      else { if (tbody || ++bodyCount !== 1 || rows.length) return undefined; tbody = true; }
    } else if (token.name === "tr" && !token.closing && !token.selfClosing && (!bodyCount || tbody)) {
      row = token; cursor = 0; cellIndex = 0;
    }
    else return undefined;
  }
  return tbody || row || cell || nestedTables ? undefined : rows;
}
