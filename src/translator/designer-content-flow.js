import { parseDesignerFdValues } from "./designer-control-values.js";
import { findMatchingCloseTag, isVoidLikeTag, scanHtmlTags } from "./designer-html-tokenizer.js";
import { attrValue, propertyFieldId } from "./xml-utils.js";

// Record source presentation facts only; target wrapping and component choices
// belong to the DSL mapper.
export function designerContentFlow(html, referenceIds, runtimeSelects = new Map()) {
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
      const width = controlWidth(html, token, type, values, runtimeSelects.get(referenceId));
      items.push({ referenceId, ...(width ? { width } : {}) });
    }
    if (token.name === "br" || type === "brcontrol") lines.push([]);
  }
  if (seen.size !== expected.size) return undefined;
  return { lines, items };
}

// A designer select face is a placeholder. Only a unique runtime binding can
// establish that its outer width is decoration rather than a runtime constraint.
function controlWidth(html, token, type, values, runtimeMatches) {
  const previous = explicitControlWidth(token.attrs, values);
  if (!isSelectFace(html, token, type) || runtimeMatches?.length !== 1) return previous;
  const runtime = runtimeMatches[0];
  if (runtime.containerWidth || runtime.uncertain || (runtime.declared && !runtime.width)) return previous;
  if (runtime.width) return runtime.width;
  if (Object.hasOwn(values, "width")) return parseWidth(values.width) || previous;
  return undefined;
}

function isSelectFace(html, token, type) {
  if (!["select", "inputselect"].includes(type) || token.name !== "div" ||
      !hasClass(token.attrs, "select_div_box")) return false;
  const end = findMatchingCloseTag(html, token.end, token.name);
  if (end < token.end) return false;
  const children = [...scanHtmlTags(html.slice(token.end, end))].filter((child) => !child.closing);
  const selects = children.filter((child) => child.name === "select");
  return selects.length === 1 &&
    styleProperty(selects[0].attrs, "display")?.trim().toLowerCase() === "none" &&
    children.some((child) => hasClass(child.attrs, "select_tag_face"));
}

function hasClass(attrs, name) {
  return attrValue(attrs, "class").split(/\s+/).includes(name);
}

// Retain all exact matches: repeated bindings, unsupported widths and sized
// non-table ancestors prevent replacing the previous designer width.
export function runtimeSelectWidthEvidence(html = "") {
  // JSP comments are server-side omissions, not rendered control evidence.
  html = String(html).replace(/<%--[\s\S]*?(?:--%>|$)/g, (comment) => comment.replace(/[^\r\n]/g, " "));
  const matches = new Map();
  const ancestors = [];
  let skipUntil = 0;
  for (const token of scanHtmlTags(html)) {
    if (token.start < skipUntil) continue;
    if (["script", "style"].includes(token.name) && !token.closing) {
      skipUntil = elementEnd(html, token);
      continue;
    }
    if (token.closing) {
      const index = ancestors.findLastIndex((ancestor) => ancestor.name === token.name);
      if (index >= 0) ancestors.splice(index);
      continue;
    }
    if (token.name === "xform:select") {
      const property = attrValue(token.attrs, "property");
      const fieldId = property.match(/^extendDataFormInfo\.value\(([A-Za-z_][\w-]*)\)$/)?.[1];
      if (fieldId) {
        const evidence = widthDeclaration(token.attrs);
        const containerWidth = ancestors.some((ancestor) => {
          if (["table", "thead", "tbody", "tfoot", "tr", "td", "th"].includes(ancestor.name)) return false;
          const width = widthDeclaration(ancestor.attrs);
          return width.declared || width.uncertain;
        });
        const entries = matches.get(fieldId) || [];
        entries.push({ ...evidence, containerWidth });
        matches.set(fieldId, entries);
      }
    }
    if (!token.selfClosing && !isVoidLikeTag(token.name)) ancestors.push(token);
  }
  return matches;
}

function styleProperty(attrs, name) {
  return [...attrValue(attrs, "style").matchAll(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]*)`, "ig"))]
    .at(-1)?.[1];
}

function widthDeclaration(attrs) {
  const style = attrValue(attrs, "style");
  // This seam accepts simple declarations only. Comments, CSS escapes and
  // template expressions can hide a width; do not interpret them as its absence.
  if (/\/\*|\*\/|[\\{}<>]/.test(style) || style.split(";").some((declaration) =>
    declaration.trim() && !/^\s*[-a-z]+\s*:[^:]*$/i.test(declaration)
  )) return { uncertain: true };
  const styleWidth = styleProperty(attrs, "width");
  if (styleWidth !== undefined) return { declared: true, width: parseWidth(styleWidth) };
  if (/(?:^|\s)width\s*=/i.test(attrs)) {
    return { declared: true, width: parseWidth(attrValue(attrs, "width")) };
  }
  return { declared: false };
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
    const width = parseWidth(value);
    if (width) return width;
  }
  return undefined;
}

function parseWidth(value) {
  const match = String(value ?? "").trim().match(/^(\d+(?:\.\d+)?|\.\d+)\s*(px|%)?$/i);
  if (!match) return undefined;
  const width = Number(match[1]);
  return Number.isFinite(width) ? { value: width, unit: match[2] === "%" ? "%" : "px" } : undefined;
}
