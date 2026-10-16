import { parseExpressionAt } from "acorn";
import { attrValue, parseFdValues, decodeEntities } from "./xml-utils.js";
import { parseStaticMarkupAttributes } from "./source-static-markup.js";

export function parseDesignerFdValues(attrs) {
  return parseFdValues(designerAttributeValue(attrs, "fd_values"));
}

export function parseDesignerControlAttributes(attrs) {
  const starts = [...String(attrs).matchAll(/(?:^|\s)fd_values\s*=\s*(["'])/ig)];
  if (starts.length !== 1) return undefined;
  const start = starts[0], raw = designerAttributeValue(attrs, "fd_values");
  const end = start.index + start[0].length + raw.length;
  if (attrs[end] !== start[1]) return undefined;
  // Exporter fd_values can contain unescaped double quotes inside double-quoted
  // HTML attributes. Its contents need their own complete-object proof.
  return parseStaticMarkupAttributes(attrs.slice(0, start.index) + ' fd_values=""' + attrs.slice(end + 1));
}

// Additional evidence may use only the complete literal object. The legacy
// field parser remains unchanged; exporter line breaks are normalized locally.
export function parseStaticDesignerStringValues(attrs, allowedKeys, multilineKeys = new Set()) {
  const raw = decodeEntities(designerAttributeValue(attrs, "fd_values"));
  let text = "", quote, escaped = false;
  for (const character of raw) {
    if (!quote) { if (character === '"' || character === "'") quote = character; text += character; }
    else if (escaped) { if (/[\r\n]/.test(character)) return undefined; escaped = false; text += character; }
    else if (character === "\\") { escaped = true; text += character; }
    else if (character === quote) { quote = undefined; text += character; }
    else text += character === "\r" ? "\\r" : character === "\n" ? "\\n" : character;
  }
  if (!text || quote || escaped) return undefined;
  const comments = []; let object;
  try { object = parseExpressionAt(text, 0, { ecmaVersion: "latest", onComment: comments }); } catch { return undefined; }
  if (object.type !== "ObjectExpression" || comments.length || text.slice(0, object.start).trim() || text.slice(object.end).trim()) return undefined;
  const result = {}, seen = new Set();
  for (const property of object.properties) {
    const key = property.key?.type === "Identifier" ? property.key.name : property.key?.type === "Literal" ? property.key.value : undefined;
    if (property.type !== "Property" || property.kind !== "init" || property.method || property.computed || property.shorthand ||
        !allowedKeys.has(key) || seen.has(key) || property.value.type !== "Literal" || typeof property.value.value !== "string" ||
        !multilineKeys.has(key) && /[\r\n]/.test(property.value.value)) return undefined;
    seen.add(key); result[key] = property.value.value;
  }
  const legacy = parseDesignerFdValues(attrs);
  return seen.size === Object.keys(legacy).length && [...seen].every(key => legacy[key] === result[key]) ? result : undefined;
}

function designerAttributeValue(attrs, name) {
  const source = String(attrs || "");
  const start = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])`, "i").exec(source);
  if (!start) return attrValue(source, name);
  const quote = start[1];
  const valueStart = start.index + start[0].length;
  for (let index = valueStart; index < source.length; index += 1) {
    if (source[index] !== quote) continue;
    const suffix = source.slice(index + 1);
    if (/^\s+(?:[A-Za-z_:][\w:.-]*)\s*=/.test(suffix) || /^\s*\/?\s*$/.test(suffix)) {
      return source.slice(valueStart, index);
    }
  }
  return attrValue(source, name);
}
