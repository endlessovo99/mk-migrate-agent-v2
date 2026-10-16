import { parseDesignerFdValues, parseDesignerControlAttributes } from "./designer-control-values.js";
import { findMatchingCloseTag, isVoidLikeTag, scanHtmlTags } from "./designer-html-tokenizer.js";
import { parseStaticMarkupAttributes, staticSourceMarkup } from "./source-static-markup.js";
import { radioFaceMatches, sourceRadioLiteralValues } from "./radio-source-proof.js";
import { attrValue, propertyFieldId, parseOptions, cleanText } from "./xml-utils.js";

// Record source presentation facts only; target wrapping and component choices
// belong to the DSL mapper.
export function designerContentFlow(html, referenceIds, runtimeSelects = new Map(), runtimeCheckboxes = new Map(), runtimeWidthlessCaptions = new Set(), runtimeWidthlessRadios = new Set()) {
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
      const width = type === "inputradio" && runtimeWidthlessRadios.has(referenceId) ? undefined : controlWidth(html, token, type, values,
        runtimeSelects.get(referenceId), runtimeCheckboxes.get(referenceId), runtimeWidthlessCaptions.has(referenceId));
      items.push({ referenceId, ...(width ? { width } : {}) });
    }
    if (token.name === "br" || type === "brcontrol") lines.push([]);
  }
  if (seen.size !== expected.size) return undefined;
  return { lines, items };
}

// A designer select face is a placeholder. Only a unique runtime binding can
// establish that its outer width is decoration rather than a runtime constraint.
function controlWidth(html, token, type, values, runtimeMatches, runtimeCheckboxMatches, runtimeWidthlessCaption) {
  const previous = explicitControlWidth(token.attrs, values);
  if (type === "textlabel" && runtimeWidthlessCaption) return undefined;
  if (!Object.hasOwn(values, "width") && isCheckboxPlaceholder(html, token, type, values) &&
      runtimeCheckboxMatches?.length === 1) {
    const runtime = runtimeCheckboxMatches[0];
    if (!runtime.declared && !runtime.uncertain && !runtime.containerWidth) return undefined;
  }
  if (!isSelectFace(html, token, type) || runtimeMatches?.length !== 1) return previous;
  const runtime = runtimeMatches[0];
  if (runtime.containerWidth || runtime.uncertain || (runtime.declared && !runtime.width)) return previous;
  if (runtime.width) return runtime.width;
  if (Object.hasOwn(values, "width")) return parseWidth(values.width) || previous;
  return undefined;
}

function isCheckboxPlaceholder(html, token, type, values) {
  if (type !== "inputcheckbox" || token.name !== "table" || !hasClass(token.attrs, "tb_noborder") ||
      styleProperty(token.attrs, "display")?.trim().toLowerCase() !== "inline") return false;
  const outerWidth = widthDeclaration(token.attrs);
  if (outerWidth.uncertain || !outerWidth.width || outerWidth.width.unit !== "px" ||
      outerWidth.width.value <= 0) return false;
  const end = findMatchingCloseTag(html, token.end, token.name);
  if (end < token.end) return false;
  const children = [...scanHtmlTags(html.slice(token.end, end))].filter(child => !child.closing);
  if (children.some(child => ["table", "script", "style"].includes(child.name))) return false;
  const inputs = children.filter(child => child.name === "input");
  const labels = children.filter(child => child.name === "label");
  return Boolean(values.id) && inputs.length > 0 && labels.length === inputs.length &&
    children.filter(child => child.name === "nobr").length === inputs.length &&
    attrValue(inputs[0].attrs, "id") === values.id &&
    inputs.every(input => attrValue(input.attrs, "type").toLowerCase() === "checkbox" &&
      (attrValue(input.attrs, "id") || attrValue(input.attrs, "attach")) === values.id) &&
    labels.every(label => attrValue(label.attrs, "attach") === values.id);
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
  return runtimeControlWidthEvidence(html, "xform:select");
}

export function runtimeCheckboxWidthEvidence(html = "") {
  return runtimeControlWidthEvidence(html, "xform:checkbox");
}

/** A radio TABLE is an editor face only when its complete runtime peer proves it. */
export function runtimeRadioWidthlessEvidence(designerHtml = "", runtimeHtml = "", metadataFields = []) {
  const designer = staticSourceMarkup(String(designerHtml)), runtimeMarkup = staticSourceMarkup(String(runtimeHtml)), result = new Set();
  if (designer === undefined || runtimeMarkup === undefined) return result;
  const tokens = [...scanHtmlTags(designer)];
  const matches = runtimeControlWidthEvidence(runtimeMarkup, "xform:radio", String(runtimeHtml));
  for (const token of tokens.filter(token => !token.closing && attrValue(token.attrs, "fd_type").toLowerCase() === "inputradio")) {
    const values = sourceRadioLiteralValues(token.attrs);
    if (!values) continue;
    const id = values.id;
    const metadata = metadataFields.filter(field => field.id === id);
    const runtime = matches.get(id);
    if (!id || !["H", "V"].includes(values.alignment) || Object.hasOwn(values, "width") ||
        tokens.filter(item => !item.closing && parseDesignerFdValues(item.attrs).id === id).length !== 1 ||
        metadata.length !== 1 || Object.keys(metadata[0].source?.metadataAttributes || {}).some(key => key.toLowerCase() === "width") ||
        token.name !== "table" || styleProperty(token.attrs, "display")?.trim().toLowerCase() !== "inline" ||
        !simpleRadioStyle(token.attrs, true) || widthDeclaration(token.attrs).width?.unit !== "px" || widthDeclaration(token.attrs).width?.value <= 0 ||
        runtime?.length !== 1 || runtime[0].declared || runtime[0].uncertain || runtime[0].containerWidth || runtime[0].guarded ||
        attrValue(runtime[0].attrs, "alignment") !== values.alignment || !simpleRadioStyle(runtime[0].attrs, false)) continue;
    const end = findMatchingCloseTag(designer, token.end, token.name);
    if (end < token.end) continue;
    const ancestors = [];
    for (const previous of tokens) {
      if (previous.start >= token.start) break;
      if (previous.closing) {
        const index = ancestors.findLastIndex(ancestor => ancestor.name === previous.name);
        if (index >= 0) ancestors.splice(index);
      } else if (!previous.selfClosing && !isVoidLikeTag(previous.name)) ancestors.push(previous);
    }
    if (radioAncestorsGuarded(ancestors)) continue;
    const body = String(designerHtml).slice(token.end, end), options = parseOptions(values.items);
    if (!options.length || options.some(option => /[<>]|\$\{|<%/.test(option.label + option.value)) ||
        !radioFaceMatches(body, values, options) || !sameRuntimeRadioOptions(runtime[0].body, options)) continue;
    result.add(id);
  }
  return result;
}

function elementBody(html, token) {
  const end = findMatchingCloseTag(html, token.end, token.name);
  return end < token.end ? "" : html.slice(token.end, end);
}

function sameRuntimeRadioOptions(body, options) {
  const tokens = [...scanHtmlTags(body)];
  const sources = tokens.filter(token => !token.closing && token.name === "xform:simpledatasource");
  if (tokens.length !== options.length * 2 || sources.length !== options.length) return false;
  let offset = 0;
  return options.every((option, index) => {
    const open = tokens[index * 2], close = tokens[index * 2 + 1], attrs = parseStaticMarkupAttributes(open.attrs);
    const valid = !body.slice(offset, open.start).trim() && open.name === "xform:simpledatasource" && !open.closing &&
      close.name === open.name && close.closing && attrs?.size === 1 && attrs.get("value") === option.value &&
      !/[<>]|\$\{|<%/.test(body.slice(open.end, close.start)) && cleanText(body.slice(open.end, close.start)) === option.label;
    offset = close.end;
    return valid && (index < options.length - 1 || !body.slice(offset).trim());
  });
}

function simpleRadioStyle(attrs, designer) {
  const parsed = designer ? parseDesignerControlAttributes(attrs) : parseStaticMarkupAttributes(attrs);
  if (!parsed) return false;
  const allowed = designer ? ["class", "style", "formdesign", "fd_type", "fd_values"] :
    ["property", "alignment", "required", "readonly", "subject", "title", "onvaluechange", "style", "width"];
  if ([...parsed.keys()].some(key => !allowed.includes(key))) return false;
  const style = attrValue(attrs, "style");
  const properties = style.split(";").filter(part => part.trim());
  const events = [...attrs.matchAll(/(?:^|\s)(on\w+)\s*=/ig)].map(match => match[1]);
  return (designer ? ["", "tb_noborder"].includes(attrValue(attrs, "class")) && ["", "landray"].includes(attrValue(attrs, "formdesign")) : !attrValue(attrs, "class")) &&
    !/(?:^|\s)hidden\s*=/i.test(attrs) &&
    events.every(name => !designer && name.toLowerCase() === "onvaluechange" && attrValue(attrs, name) === "__xformDispatch") &&
    !/\/\*|\*\/|[\\{}<>]/.test(style) && properties.every(part => /^\s*(?:width\s*:\s*\d+(?:\.\d+)?px|display\s*:\s*inline)\s*$/i.test(part)) &&
    (designer || !widthDeclaration(attrs).declared);
}

function runtimeControlWidthEvidence(html, controlTag, rawHtml = html) {
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
    if (token.name === controlTag) {
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
        entries.push({ ...evidence, containerWidth, ...(controlTag === "xform:radio" ? {
          attrs: token.attrs, body: elementBody(rawHtml, token), guarded: radioAncestorsGuarded(ancestors)
        } : {}) });
        matches.set(fieldId, entries);
      }
    }
    if (!token.selfClosing && !isVoidLikeTag(token.name)) ancestors.push(token);
  }
  return matches;
}

function radioAncestorsGuarded(ancestors) {
  const geometry = ["table", "thead", "tbody", "tfoot", "tr", "td", "th"];
  const transparent = ["div", "form", "xform:editshow", "xform:viewshow"];
  return ancestors.some(ancestor => {
    const attrs = ancestor.attrs, style = attrValue(attrs, "style");
    const geometryStyle = style.split(";").filter(declaration => declaration.trim());
    const geometryKeys = geometryStyle.map(declaration => declaration.split(":")[0].trim().toLowerCase());
    return !geometry.includes(ancestor.name) && !transparent.includes(ancestor.name) ||
      /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs) || attrValue(attrs, "canshow").toLowerCase() === "false" ||
      attrValue(attrs, "showstatus").toLowerCase() === "noshow" ||
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:;|$)/i.test(style) ||
      geometry.includes(ancestor.name) && (
        attrValue(attrs, "class").split(/\s+/).filter(Boolean).some(name => !["tb_normal", "tb_noborder", "td_normal", "td_normal_title"].includes(name)) ||
        new Set(geometryKeys).size !== geometryKeys.length || geometryStyle.some(declaration =>
          !/^\s*(?:width|height)\s*:\s*(?:auto|\d+(?:\.\d+)?(?:px|%))\s*$/i.test(declaration))) ||
      !geometry.includes(ancestor.name) && (attrValue(attrs, "class") ||
        style.split(";").some(declaration => declaration.trim() && !/^\s*display\s*:\s*inline\s*$/i.test(declaration)));
  });
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
