import { parseExpressionAt } from "acorn";
import { scanHtmlTags, isVoidLikeTag } from "./designer-html-tokenizer.js";
import { parseDesignerFdValues } from "./designer-control-values.js";

const SELECT_KEYS = new Set(["id", "_label_bind", "label", "_label_bind_id", "canShow", "required", "dataType", "items", "formula", "reCalculate", "defaultValue"]);
const JSP_KEYS = new Set(["id", "label"]);
const normalize = text => String(text).replace(/\r\n?/g, "\n").trim();
const blank = text => /^[ \t\r\n\f]*$/.test(text);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Only the omitted-tail path consumes this raw, select-only prefix contract. */
export function trailingBlankPrefixProof({ designerHtml, runtimeHtml, sourceCell, runtimeCell, tableId, scriptFragments = [], scriptSources = [] }) {
  const source = fragment(designerHtml.slice(sourceCell.contentStart, sourceCell.contentEnd));
  const runtime = fragment(runtimeHtml.slice(runtimeCell.contentStart, runtimeCell.contentEnd));
  if (!source || !runtime || source.nodes.length < 1 || runtime.nodes.length < 1) return undefined;
  const select = source.nodes[0], values = sourceSelect(select, tableId);
  if (!values) return undefined;
  const carriers = [], scripts = [];
  for (const node of source.nodes.slice(1)) {
    const carrier = sourceCarrier(node, scriptFragments, scriptSources);
    if (!carrier || carrier.id === values.id || carriers.includes(carrier.id)) return undefined;
    carriers.push(carrier.id); scripts.push(...carrier.scripts);
  }
  if (!runtimeSelect(runtime.nodes[0], values)) return undefined;
  const renderedScripts = scriptNodes(runtime.nodes.slice(1));
  if (!renderedScripts || !same(renderedScripts, scripts)) return undefined;
  if (!uniqueRuntimeBinding(runtimeHtml, values.id, runtimeCell.contentStart + runtime.nodes[0].start) ||
      !uniqueSourceBinding(designerHtml, values.id, sourceCell.contentStart + select.start)) return undefined;
  return { id: values.id, carrierIds: carriers };
}

function sourceSelect(node, tableId) {
  if (node.name !== "div" || !keys(node.attrs, ["class", "style", "formdesign", "fd_values", "fd_type"]) ||
      node.attrs.get("fd_type")?.toLowerCase() !== "select" || node.attrs.get("class") !== "select_div_box" ||
      ![undefined, "landray"].includes(node.attrs.get("formdesign")) || !inlineStyle(node.attrs.get("style"))) return undefined;
  const values = stringValues(node.attrs.get("fd_values"), SELECT_KEYS);
  if (!values || !/^[A-Za-z_][\w-]*$/.test(values.id || "") || ![undefined, "String"].includes(values.dataType) ||
      ![undefined, "", "true"].includes(values.canShow) || ![undefined, "", "true", "false"].includes(values.required) ||
      ![undefined, "", "true", "false"].includes(values._label_bind) || ![undefined, ""].includes(values.formula) ||
      ![undefined, "", "false"].includes(values.reCalculate) || typeof values.label !== "string" ||
      !values.label || /[<>]|\$\{|<%/.test(values.label)) return undefined;
  const options = optionItems(values.items);
  if (!options || !whitespaceAroundChildren(node)) return undefined;
  let faces = 0, selects = 0, stars = 0;
  const decorations = new Set();
  for (const child of node.children) {
    if (child.name === "select") {
      if (++selects !== 1 || !keys(child.attrs, ["id", "style", "label", "tablename", "required", "_required", "canshow", "items", "itemvalues"]) ||
          child.attrs.get("id") !== values.id || !/^\s*display\s*:\s*none\s*;?\s*$/i.test(child.attrs.get("style") || "") ||
          child.children.length || !blank(child.text) ||
          child.attrs.has("label") && child.attrs.get("label") !== values.label ||
          child.attrs.has("tablename") && child.attrs.get("tablename") !== tableId ||
          ["required", "_required"].some(key => child.attrs.has(key) && child.attrs.get(key) !== (values.required || "false")) ||
          child.attrs.has("canshow") && child.attrs.get("canshow") !== (values.canShow || "true") ||
          child.attrs.has("items") && child.attrs.get("items") !== options.map(option => option.label).join(";") ||
          child.attrs.has("itemvalues") && child.attrs.get("itemvalues") !== options.map(option => option.value).join(";")) return undefined;
    } else if (child.name === "label") {
      const decoration = selectDecoration(child, { ...values, options }, decorations);
      if (!decoration) return undefined;
      faces += decoration.faces; stars += decoration.stars;
    } else if (requiredStar(child, values.required)) stars++;
    else return undefined;
  }
  return faces === 1 && selects === 1 && stars <= 1 ? { ...values, options } : undefined;
}

function selectDecoration(node, values, seen) {
  if (node.name !== "label" || node.attrs.size !== 1 || !keys(node.attrs, ["class"])) return undefined;
  const kind = node.attrs.get("class");
  if (!["select_tag_left", "select_tag_right", "select_tag_face"].includes(kind) || seen.has(kind)) return undefined;
  seen.add(kind);
  if (kind === "select_tag_face") {
    const text = decodeOnce(node.text)?.trim();
    if (text === undefined || !/^---[ \t]*请选择[ \t]*---$/.test(text) && text !== "" && !values.options.some(option => option.label === text) ||
        node.children.some(child => !requiredStar(child, values.required))) return undefined;
    return { faces: 1, stars: node.children.length };
  }
  if (!blank(node.text) || node.children.length > 1) return undefined;
  if (!node.children.length) return { faces: 0, stars: 0 };
  const child = node.children[0], next = child.attrs.get("class");
  if (!(kind === "select_tag_left" && ["select_tag_right", "select_tag_face"].includes(next) ||
        kind === "select_tag_right" && next === "select_tag_face")) return undefined;
  return selectDecoration(child, values, seen);
}

function runtimeSelect(node, values) {
  if (node.name !== "xform:select" || !keys(node.attrs, ["property", "subject", "title", "required", "showpleaseselect", "onvaluechange"]) ||
      node.attrs.get("property") !== `extendDataFormInfo.value(${values.id})` ||
      ["subject", "title"].some(key => node.attrs.has(key) && node.attrs.get(key) !== values.label) ||
      node.attrs.has("required") && node.attrs.get("required") !== (values.required || "false") ||
      ![undefined, "true", "false"].includes(node.attrs.get("showpleaseselect")) ||
      ![undefined, "__xformDispatch"].includes(node.attrs.get("onvaluechange")) || !whitespaceAroundChildren(node)) return false;
  const options = [];
  for (const child of node.children) {
    const label = decodeOnce(child.text);
    if (child.name !== "xform:simpledatasource" || !keys(child.attrs, ["value"]) || child.children.length || label === undefined || !child.attrs.has("value")) return false;
    options.push({ label: label.trim(), value: child.attrs.get("value") });
  }
  return same(options, values.options);
}

function sourceCarrier(node, fragments, sources) {
  if (node.name !== "div" || !keys(node.attrs, ["fd_type", "fd_values", "formdesign", "id", "mobileview", "style", "title"]) ||
      node.attrs.get("fd_type")?.toLowerCase() !== "jsp" || ![undefined, "landray"].includes(node.attrs.get("formdesign")) ||
      ![undefined, "default"].includes(node.attrs.get("mobileview")) ||
      node.attrs.has("style") && !inlineStyle(node.attrs.get("style"))) return undefined;
  const values = stringValues(node.attrs.get("fd_values"), JSP_KEYS), id = node.attrs.get("id");
  if (!values || !/^[A-Za-z_][\w-]*$/.test(id || "") || values.id !== id || node.children.length !== 1 || !whitespaceAroundChildren(node)) return undefined;
  let input = node.children[0];
  if (input.name === "label") {
    const map = styles(input.attrs.get("style")), comments = [], text = input.attrs.get("ondblclick");
    if (!keys(input.attrs, ["class", "style", "ondblclick"]) || input.attrs.get("class") !== "button_img" || map?.size !== 2 ||
        !/^center[ \t]+-480px$/i.test(map.get("background-position") || "") ||
        (map.get("margin") || "").replace(/\s+/g, " ") !== "2px 3px 3px 2px" ||
        typeof text !== "string" || input.children.length !== 1 || !whitespaceAroundChildren(input)) return undefined;
    let call;
    try { call = parseExpressionAt(text, 0, { ecmaVersion: "latest", onComment: comments }); } catch { return undefined; }
    if (comments.length || text.slice(0, call.start).trim() || !["", ";"].includes(text.slice(call.end).trim()) ||
        call.type !== "CallExpression" || call.optional || call.callee.type !== "Identifier" || call.callee.name !== "Designer_Control_JSP_ShowEditFrame" ||
        call.arguments.length !== 2 || call.arguments[0].type !== "Identifier" || call.arguments[0].name !== "event" || call.arguments[1].type !== "ThisExpression") return undefined;
    input = input.children[0];
  }
  if (input.name !== "input" || input.attrs.size !== 2 || !keys(input.attrs, ["type", "value"]) || input.attrs.get("type")?.toLowerCase() !== "hidden") return undefined;
  const content = input.attrs.get("value"), parsed = fragment(content), parsedScripts = parsed && scriptNodes(parsed.nodes);
  if (!parsedScripts?.length) return undefined;
  const matched = fragments.filter(candidate => candidate.id === id);
  if (matched.length !== 1 || matched[0].sourceRef !== `source.form.jsp.${id}` || matched[0].sourceKey !== "fdDesignerHtml" ||
      matched[0].sourceType !== "designer-jsp" || normalize(matched[0].content) !== normalize(content)) return undefined;
  const expected = sources.filter(source => source.fragmentId === id);
  if (expected.length !== parsedScripts.length || new Set(expected.map(source => source.id)).size !== expected.length || expected.some((source, index) =>
    source.id !== `${id}.script.${index + 1}` || source.sourceRef !== `source.form.jsp.${id}.script.${index + 1}` ||
    source.sourceKey !== "fdDesignerHtml" || source.sourceType !== "designer-jsp" ||
    normalize(source.javascript) !== parsedScripts[index].javascript || source.displayGate !== parsedScripts[index].displayGate)) return undefined;
  return { id, scripts: parsedScripts };
}

function scriptNodes(nodes, gate) {
  const scripts = [];
  for (const node of nodes) {
    if (node.name === "script") {
      if (!keys(node.attrs, ["type", "language"]) ||
          ![undefined, "text/javascript"].includes(node.attrs.get("type")?.toLowerCase()) ||
          ![undefined, "javascript"].includes(node.attrs.get("language")?.toLowerCase()) || !normalize(node.text)) return undefined;
      scripts.push({ javascript: normalize(node.text), ...(gate ? { displayGate: gate } : {}) });
    } else if (!gate && ["xform:editshow", "xform:viewshow"].includes(node.name) && node.attrs.size === 0 && whitespaceAroundChildren(node)) {
      const nested = scriptNodes(node.children, node.name === "xform:editshow" ? "xform:editShow" : "xform:viewShow");
      if (!nested?.length) return undefined;
      scripts.push(...nested);
    } else return undefined;
  }
  return scripts;
}

function uniqueRuntimeBinding(html, id, start) {
  const canonical = `extendDataFormInfo.value(${id})`;
  let count = 0;
  for (const token of scanHtmlTags(html)) {
    if (token.closing) continue;
    const attrs = attributes(token.attrs, token.name === "input"), property = attrs?.get("property");
    if (!attrs) { if (/\bproperty\b/i.test(token.attrs)) return false; continue; }
    if (typeof property !== "string") continue;
    // Recognizable natural identity is poison unless the entire property is the
    // sole canonical main binding. Do not normalize quoted/suffixed aliases.
    if (!new RegExp(`(^|[^\\w-])${id}([^\\w-]|$)`).test(property)) continue;
    if (property !== canonical || token.name !== "xform:select" || token.start !== start) return false;
    count++;
  }
  return count === 1;
}
function uniqueSourceBinding(html, id, start) {
  let count = 0;
  for (const token of scanHtmlTags(html)) {
    if (token.closing) continue;
    const type = /\bfd_type\s*=\s*(["'])([^"']+)\1/i.exec(token.attrs)?.[2]?.toLowerCase();
    if (!type || ["jsp", "textlabel"].includes(type)) continue;
    if (parseDesignerFdValues(token.attrs).id !== id) continue;
    if (token.start !== start || type !== "select") return false;
    count++;
  }
  return count === 1;
}

function requiredStar(node, required) {
  return required === "true" && node.name === "span" && node.attrs.size === 1 && node.attrs.get("class") === "txtstrong" &&
    node.children.length === 0 && decodeOnce(node.text)?.trim() === "*";
}
function keys(attrs, allowed) { return attrs && [...attrs.keys()].every(key => allowed.includes(key)); }
function optionItems(value) {
  if (typeof value !== "string") return undefined;
  const items = value.split(/\r\n|\r|\n|;/).filter(item => item.trim()).map(item => item.split("|"));
  if (!items.length || items.some(parts => parts.length > 2 || !parts[0].trim())) return undefined;
  const options = items.map(parts => ({ label: parts[0].trim(), value: (parts[1] ?? parts[0]).trim() }));
  return new Set(options.map(option => option.value)).size === options.length ? options : undefined;
}
function stringValues(text, allowed) {
  if (typeof text !== "string") return undefined;
  text = quotedLineBreaks(text);
  if (text === undefined) return undefined;
  const comments = []; let object;
  try { object = parseExpressionAt(text, 0, { ecmaVersion: "latest", onComment: comments }); } catch { return undefined; }
  if (object.type !== "ObjectExpression" || comments.length || text.slice(0, object.start).trim() || text.slice(object.end).trim()) return undefined;
  const values = Object.create(null);
  for (const property of object.properties) {
    const key = property.key?.type === "Identifier" ? property.key.name : property.key?.type === "Literal" ? property.key.value : undefined;
    if (property.type !== "Property" || property.kind !== "init" || property.computed || property.method || property.shorthand ||
        !allowed.has(key) || Object.hasOwn(values, key) || property.value.type !== "Literal" || typeof property.value.value !== "string" ||
        key !== "items" && /[\r\n]/.test(property.value.value)) return undefined;
    values[key] = property.value.value;
  }
  return values;
}
function quotedLineBreaks(text) {
  let quote, escaped = false, result = "";
  for (const character of text) {
    if (!quote) { if (character === '"' || character === "'") quote = character; result += character; }
    else if (escaped) { if (/[\r\n]/.test(character)) return undefined; escaped = false; result += character; }
    else if (character === "\\") { escaped = true; result += character; }
    else if (character === quote) { quote = undefined; result += character; }
    else result += character === "\r" ? "\\r" : character === "\n" ? "\\n" : character;
  }
  return quote || escaped ? undefined : result;
}
function styles(text = "") {
  const result = new Map();
  for (const item of text.split(";")) {
    if (!item.trim()) continue;
    const match = /^\s*([-a-z]+)\s*:\s*([^:]+?)\s*$/i.exec(item), key = match?.[1].toLowerCase();
    if (!match || result.has(key)) return undefined;
    result.set(key, match[2]);
  }
  return result;
}
function inlineStyle(text) {
  const map = styles(text);
  return map && [...map].every(([key, value]) => key === "display" && /^inline$/i.test(value) ||
    key === "width" && (/^auto$/i.test(value) || /^\d+(?:\.\d+)?px$/i.test(value) && Number.parseFloat(value) > 0));
}
function whitespaceAroundChildren(node) { return blank(node.text); }

// Parse only the current finite HTML fragment. Unlike staticSourceMarkup, this
// preserves comments, opaque elements and script bodies as evidence to consume.
function fragment(html) {
  if (typeof html !== "string") return undefined;
  const tokens = [...scanHtmlTags(html)], nodes = [], stack = [];
  let cursor = 0, skip = 0;
  const addText = text => { if (stack.length) stack.at(-1).text += text; else if (!blank(text)) throw Error("fragment text"); };
  try {
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]; if (token.start < skip) continue;
      addText(html.slice(cursor, token.start));
      if (token.closing) {
        const node = stack.pop(); if (!node || node.name !== token.name || token.attrs.trim()) return undefined;
        node.end = token.end;
      } else {
        const attrs = attributes(token.attrs, token.name === "input"); if (!attrs) return undefined;
        const node = { name: token.name, attrs, start: token.start, end: token.end, children: [], text: "" };
        (stack.length ? stack.at(-1).children : nodes).push(node);
        if (token.name === "script") {
          if (token.selfClosing) return undefined;
          const close = /<\/\s*script\s*>/ig; close.lastIndex = token.end; const match = close.exec(html);
          if (!match) return undefined;
          node.text = html.slice(token.end, match.index); node.end = close.lastIndex; skip = close.lastIndex; cursor = skip; continue;
        }
        if (!token.selfClosing && !isVoidLikeTag(token.name)) stack.push(node);
      }
      cursor = token.end;
    }
    addText(html.slice(cursor));
    return stack.length ? undefined : { nodes };
  } catch { return undefined; }
}
function attributes(text, carrierInput = false) {
  const source = text.replace(/\/\s*$/, ""), result = new Map();
  const rule = /\s*([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/y;
  let offset = 0;
  while (source.slice(offset).trim()) {
    if (offset && !/\s/.test(source[offset])) return undefined;
    rule.lastIndex = offset; const match = rule.exec(source), key = match?.[1].toLowerCase();
    if (!match || result.has(key)) return undefined;
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    if (/[<>]/.test(raw) && !(carrierInput && key === "value")) return undefined;
    const value = decodeOnce(raw, carrierInput && key === "value"); if (value === undefined) return undefined;
    result.set(key, value); offset = rule.lastIndex;
  }
  return result;
}
function decodeOnce(text, bareAmpersands = false) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: "\u00a0" };
  let result = "", offset = 0;
  for (const match of String(text).matchAll(/&([^;&\s]+);/g)) {
    const before = text.slice(offset, match.index); if (!bareAmpersands && before.includes("&")) return undefined;
    let value = Object.hasOwn(named, match[1]) ? named[match[1]] : undefined;
    if (value === undefined) {
      const numeric = /^#(?:x([0-9a-fA-F]+)|(\d+))$/.exec(match[1]);
      const code = numeric && Number.parseInt(numeric[1] || numeric[2], numeric[1] ? 16 : 10);
      if (!Number.isInteger(code) || !([9, 10, 13].includes(code) || code >= 32 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) return undefined;
      value = String.fromCodePoint(code);
    }
    result += before + value; offset = match.index + match[0].length;
  }
  const rest = text.slice(offset); return !bareAmpersands && rest.includes("&") ? undefined : result + rest;
}
