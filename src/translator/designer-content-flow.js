import { parseDesignerFdValues } from "./designer-control-values.js";
import { findMatchingCloseTag, isVoidLikeTag, scanHtmlTags } from "./designer-html-tokenizer.js";
import { attrValue, propertyFieldId } from "./xml-utils.js";

// Record source presentation facts only; target wrapping and component choices
// belong to the DSL mapper.
export function designerContentFlow(html, referenceIds) {
  const expected = new Set(referenceIds);
  if (!expected.size) return undefined;
  const seen = new Set();
  const lines = [[]];
  const items = [];

  for (const { token, type } of sourceCellElements(html)) {
    const values = type ? parseDesignerFdValues(token.attrs) : {};
    const referenceId = values.id || propertyFieldId(attrValue(token.attrs, "property")) ||
      attrValue(token.attrs, "id");
    if (type && expected.has(referenceId) && !seen.has(referenceId)) {
      seen.add(referenceId);
      lines.at(-1).push(referenceId);
      const width = explicitControlWidth(token.attrs, values);
      items.push({ referenceId, ...(width ? { width } : {}) });
    }
    if (token.name === "br" || type === "brcontrol") lines.push([]);
  }
  if (seen.size !== expected.size) return undefined;
  return { lines, items };
}

export function hasTopLevelDesignerBreak(html) {
  for (const { token, type } of sourceCellElements(html)) {
    if (token.name === "br" || type === "brcontrol") return true;
  }
  return false;
}

function* sourceCellElements(html) {
  let skipUntil = 0;

  for (const token of scanHtmlTags(html)) {
    if (token.start < skipUntil) continue;
    if (token.closing) continue;
    const type = attrValue(token.attrs, "fd_type").toLowerCase();
    if (["script", "style"].includes(token.name) || type === "jsp") {
      skipUntil = elementEnd(html, token);
      continue;
    }
    // Ordinary presentation wrappers and rights containers are transparent.
    // Atomic controls and nested tables define their own content scope.
    yield { token, type };
    // Typed controls own their internal markup. In particular, an editor's BR
    // is not a line break between the cell's controls.
    if (token.name === "table" || (type && type !== "right")) {
      skipUntil = elementEnd(html, token);
      continue;
    }
  }
}

export function filterContentFlow(contentFlow, referenceIds) {
  if (!contentFlow) return undefined;
  const retained = new Set(referenceIds);
  return {
    lines: contentFlow.lines.map((line) => line.filter((id) => retained.has(id))),
    items: contentFlow.items.filter((item) => retained.has(item.referenceId))
  };
}

function elementEnd(html, token) {
  if (token.selfClosing || isVoidLikeTag(token.name)) return token.end;
  if (["script", "style"].includes(token.name)) {
    const close = new RegExp(`</${token.name}\\s*>`, "ig");
    close.lastIndex = token.end;
    const match = close.exec(html);
    return match ? match.index + match[0].length : html.length;
  }
  const closeStart = findMatchingCloseTag(html, token.end, token.name);
  if (closeStart < token.end) return html.length;
  return html.indexOf(">", closeStart) + 1;
}

function explicitControlWidth(attrs, values) {
  const style = attrValue(attrs, "style");
  const styleWidth = [...style.matchAll(/(?:^|;)\s*width\s*:\s*([^;]+)/ig)].at(-1)?.[1];
  for (const value of [styleWidth, attrValue(attrs, "width"), values.width]) {
    const match = String(value ?? "").trim().match(/^(\d+(?:\.\d+)?|\.\d+)\s*(px|%)?$/i);
    if (!match) continue;
    const width = Number(match[1]);
    if (Number.isFinite(width)) return { value: width, unit: match[2] === "%" ? "%" : "px" };
  }
  return undefined;
}
