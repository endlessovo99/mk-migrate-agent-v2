import { createHash } from "node:crypto";
import { parse } from "acorn";
import { scanHtmlTags, findMatchingCloseTag } from "./designer-html-tokenizer.js";
import { staticSourceMarkup, parseStaticMarkupAttributes } from "./source-static-markup.js";
import { remoteSelectorOmissionScriptClosure } from "./remote-selector-script-closure.js";

const hash = value => "sha256:" + createHash("sha256").update(value).digest("hex");
const identifier = value => typeof value === "string" && /^[A-Za-z_$][\w$]*$/.test(value);
const field = value => typeof value === "string" && /^[A-Za-z_][\w-]*$/.test(value);
const inside = (element, token) => element.start < token.start && token.end <= element.contentEnd;
const innermost = elements => [...elements].sort((a, b) => a.end - a.start - (b.end - b.start))[0];
const readonly = value => /^\s*readOnly\s*=\s*(['"])readOnly\1\s*$/i.test(value || "");

/**
 * Identify only exported existing-row replicas of an already closed lookup.
 * Same-named handlers alone confer no ownership. Proofs contain offsets and
 * hashes, never source scripts, request locators, query keys or alert text.
 */
export function remoteSelectorOmissionDuplicateAnchors({ html, contract, javascriptSha256 } = {}) {
  try { return duplicates(html, contract, javascriptSha256); } catch { return []; }
}

function duplicates(html, contract, javascriptSha256) {
  if (typeof html !== "string" || !["REST","SQL"].includes(contract?.kind) || contract.status !== "static" || !field(contract.tableId) || !field(contract.fieldId) ||
      !/^sha256:[a-f0-9]{64}$/.test(javascriptSha256 || "")) return [];
  const markup = staticSourceMarkup(html);
  if (markup === undefined) return [];
  const tokens = [...scanHtmlTags(markup)], tokenAt = new Map(tokens.map(token => [token.start, token]));
  const elements = tokens.filter(token => !token.closing && !token.selfClosing && ["table", "tr", "td", "th", "c:foreach"].includes(token.name)).flatMap(token => {
    const contentEnd = findMatchingCloseTag(markup, token.end, token.name), closing = tokenAt.get(contentEnd), attrs = parseStaticMarkupAttributes(token.attrs);
    return contentEnd < token.end || !closing?.closing || closing.name !== token.name || !attrs ? [] : [{ ...token, contentEnd, end: closing.end, attrs }];
  });
  const tables = elements.filter(element => element.name === "table"), ownerTables = tables.filter(table => table.attrs.get("id") === "TABLE_DL_" + contract.tableId);
  if (ownerTables.length !== 1) return [];
  const anchors = tokens.filter(token => !token.closing && token.name === "a").flatMap(token => {
    const attrs = parseStaticMarkupAttributes(token.attrs);
    return attrs?.has("onclick") ? [{ ...token, attrs }] : [];
  });
  const bindings = tokens.filter(token => !token.closing && token.name === "xform:text").flatMap(token => {
    const attrs = parseStaticMarkupAttributes(token.attrs);
    return attrs ? [{ ...token, attrs }] : [];
  });
  const result = [];
  for (const anchor of anchors) {
    const table = innermost(tables.filter(element => inside(element, anchor)));
    if (table !== ownerTables[0]) continue;
    const loops = elements.filter(element => element.name === "c:foreach" && inside(element, anchor));
    if (loops.length !== 1) continue;
    const loop = loops[0], status = loop.attrs.get("varstatus"), bean = loop.attrs.get("var");
    if (!identifier(status) || !identifier(bean) || bean === status || loop.attrs.get("items") !== "${_xformForm.extendDataFormInfo.formData." + contract.tableId + "}" || !inside(table, loop)) continue;
    const row = innermost(elements.filter(element => element.name === "tr" && inside(element, anchor)));
    const cell = innermost(elements.filter(element => ["td", "th"].includes(element.name) && inside(element, anchor)));
    if (!row || !cell || !inside(loop, row) || !inside(row, cell) || row.attrs.get("type") !== "templateRow" || anchors.filter(candidate => inside(cell, candidate)).length !== 1) continue;
    let event;
    try { event = parse(anchor.attrs.get("onclick"), { ecmaVersion: "latest" }).body; } catch { continue; }
    const invocation = event.length === 1 && event[0].type === "ExpressionStatement" ? event[0].expression : undefined;
    if (invocation?.type !== "CallExpression" || invocation.optional || invocation.callee?.type !== "Identifier" || invocation.arguments.length !== 1 ||
        invocation.arguments[0]?.type !== "Literal" || invocation.arguments[0].value !== "${" + status + ".index}") continue;
    const address = "extendDataFormInfo.value(" + contract.tableId + ".${" + status + ".index}.";
    const primary = bindings.filter(binding => inside(cell, binding) && binding.attrs.get("property") === address + contract.fieldId + ")");
    const display = bindings.filter(binding => inside(cell, binding) && binding.attrs.get("property") === address + contract.fieldId + "_name)");
    if (primary.length !== 1 || display.length !== 1 || primary[0].attrs.get("showstatus") !== "noShow" || !readonly(display[0].attrs.get("htmlelementproperties"))) continue;
    const scripts = [...html.slice(cell.start, cell.end).matchAll(/(<script\b([^>]*)>)([\s\S]*?)(<\/script\s*>)/gi)];
    if (scripts.length !== 1) continue;
    const match = scripts[0], attrs = parseStaticMarkupAttributes(match[2]), javascript = match[3];
    if (!attrs || [...attrs].some(([key, value]) => !(key === "type" && value.toLowerCase() === "text/javascript" || key === "language" && value.toLowerCase() === "javascript")) || hash(javascript.trim()) !== javascriptSha256) continue;
    let ast;
    try { ast = parse(javascript, { ecmaVersion: "latest" }); } catch { continue; }
    const definitions = ast.body.filter(node => node.type === "FunctionDeclaration" && node.id?.name === invocation.callee.name);
    if (definitions.length !== 1) continue;
    const dialogs = [];
    walk(definitions[0], node => { if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "Dialog_List") dialogs.push(node); });
    if (dialogs.length !== 1) continue;
    const closure = remoteSelectorOmissionScriptClosure({ javascript, selector: definitions[0], dialog: dialogs[0], contract });
    if (!closure || closure.javascriptSha256 !== javascriptSha256 || closure.dependencies.selector !== invocation.callee.name) continue;
    const scriptStart = cell.start + match.index, scriptEnd = scriptStart + match[0].length;
    result.push({ anchorStart: anchor.start, anchorEnd: anchor.end, sha256: hash(html.slice(anchor.start, anchor.end)),
      cellStart: cell.start, cellEnd: cell.end, cellSha256: hash(html.slice(cell.start, cell.end)),
      loopStart: loop.start, loopEnd: loop.end, loopSha256: hash(html.slice(loop.start, loop.end)),
      tableStart: table.start, tableEnd: table.end, tableId: contract.tableId, fieldId: contract.fieldId,
      scriptStart, scriptEnd, scriptSha256: hash(html.slice(scriptStart, scriptEnd)), javascriptSha256,
      selectorName: invocation.callee.name, rowVariable: status,
      bindings: [primary[0], display[0]].map(binding => ({ start: binding.start, end: binding.end, sha256: hash(html.slice(binding.start, binding.end)), role: binding === primary[0] ? "primary-hidden" : "display-readonly" })) });
  }
  return result;
}
function walk(node, callback) {
  if (!node || typeof node !== "object") return;
  callback(node);
  for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(child => walk(child, callback)) : walk(value, callback);
}
