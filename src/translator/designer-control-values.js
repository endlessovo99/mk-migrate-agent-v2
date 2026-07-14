import { attrValue, parseFdValues } from "./xml-utils.js";

export function parseDesignerFdValues(attrs) {
  return parseFdValues(designerAttributeValue(attrs, "fd_values"));
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
