import { parseXmlAttributes } from "./xml-utils.js";

export function matchingElementFragment(html, match) {
  const tagName = match[1];
  const start = match.index;
  const openEnd = start + match[0].length;
  if (isVoidLikeTag(tagName)) return match[0];
  const end = findMatchingCloseTag(html, openEnd, tagName);
  return end > openEnd ? html.slice(start, end + `</${tagName}>`.length) : match[0];
}

export function isVoidLikeTag(tagName = "") {
  return ["input", "br", "hr", "img", "meta", "link"].includes(String(tagName).toLowerCase());
}

export function findMatchingCloseTag(html, contentStart, tagName) {
  let depth = 1;
  const expected = String(tagName).toLowerCase();
  for (const token of scanHtmlTags(html, contentStart)) {
    if (token.name !== expected) continue;
    if (token.closing) {
      depth -= 1;
      if (depth === 0) return token.start;
    } else if (!token.selfClosing && !isVoidLikeTag(token.name)) {
      depth += 1;
    }
  }
  return html.length;
}

export function* scanHtmlTags(html, startAt = 0) {
  const source = String(html || "");
  for (let index = Math.max(0, startAt); index < source.length; index += 1) {
    if (source[index] !== "<") continue;
    if (source.startsWith("<!--", index)) {
      const commentEnd = source.indexOf("-->", index + 4);
      index = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }
    let quote = "";
    let end = index + 1;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote) {
        if (char === quote && source[end - 1] !== "\\") quote = "";
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === ">") break;
    }
    if (end >= source.length) return;
    const raw = source.slice(index, end + 1);
    const match = raw.match(/^<\s*(\/?)\s*([A-Za-z][\w:-]*)\b/);
    if (!match) {
      index = end;
      continue;
    }
    yield {
      start: index,
      end: end + 1,
      raw,
      attrs: raw.slice(match[0].length, -1),
      name: match[2].toLowerCase(),
      closing: Boolean(match[1]),
      selfClosing: /\/\s*>$/.test(raw)
    };
    index = end;
  }
}

export function splitDirectChildRows(fragment) {
  const rows = [];
  let tableDepth = 0;
  let rowStart = -1;
  for (const token of scanHtmlTags(fragment)) {
    if (token.name === "table") {
      tableDepth = token.closing ? Math.max(0, tableDepth - 1) : tableDepth + 1;
      continue;
    }
    if (tableDepth === 0 && token.name === "tr" && !token.closing) {
      rowStart = token.start;
      continue;
    }
    if (tableDepth === 0 && token.name === "tr" && token.closing && rowStart >= 0) {
      rows.push(fragment.slice(rowStart, token.end));
      rowStart = -1;
    }
  }
  if (rows.length) return rows;
  return [...fragment.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
}

export function splitDirectChildCells(rowHtml) {
  const cells = [];
  let tableDepth = 0;
  let cell;
  for (const token of scanHtmlTags(rowHtml)) {
    if (token.name === "table" && cell) {
      tableDepth = token.closing ? Math.max(0, tableDepth - 1) : tableDepth + 1;
      continue;
    }
    if (tableDepth === 0 && !cell && ["td", "th"].includes(token.name) && !token.closing) {
      cell = { start: token.start, tag: token.name, attrs: token.attrs };
      continue;
    }
    if (tableDepth === 0 && cell && token.name === cell.tag && token.closing) {
      const cellHtml = rowHtml.slice(cell.start, token.end);
      const openMatch = cellHtml.match(/^<(td|th)\b([^>]*)>/i);
      const bodyStart = openMatch ? openMatch[0].length : 0;
      cells.push({
        attrs: parseXmlAttributes(cell.attrs || openMatch?.[2] || ""),
        body: cellHtml.slice(bodyStart, token.start - cell.start)
      });
      cell = undefined;
    }
  }
  return cells;
}
