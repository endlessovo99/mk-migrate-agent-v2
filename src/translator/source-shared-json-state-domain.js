import { createHash } from "node:crypto";
import { parse } from "acorn";
import { scanHtmlTags } from "./designer-html-tokenizer.js";

// Bind authored script order to the executable Display export, not array order.
export function sharedJsonStateSourceDomain(template = {}, sources = []) {
  const display = String(template.fdDisplayJsp || "");
  if (!display || !sources.length) return undefined;
  const parsed = sources.map(source => ({ source, ast: ast(source.javascript) }));
  if (parsed.some(entry => !entry.ast)) return undefined;
  const scripts = [...display.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map(match => ({
    start: match.index, end: match.index + match[0].length, javascript: match[2], attrs: match[1], ast: ast(match[2])
  }));
  if (!scripts.length || scripts.length !== [...display.matchAll(/<script\b/gi)].length || scripts.some(script => !script.ast ||
    script.attrs.replace(/\s*(?:type|language)\s*=\s*(["'])(?:text\/javascript|application\/javascript|javascript)\1/gi, "").trim())) return undefined;
  const gates = [...scanHtmlTags(display)].filter(token => ["xform:editshow", "xform:viewshow"].includes(token.name) &&
    !scripts.some(script => token.start >= script.start && token.start < script.end));
  const stack = [], ordered = [], helperNames = new Set(parsed.flatMap(entry => entry.ast.body.filter(node => node.type === "FunctionDeclaration").map(node => node.id.name)));
  let gateIndex = 0;
  for (const [order, script] of scripts.entries()) {
    let dynamic = false;
    walk(script.ast, (node, parent) => {
      if (node.type === "Identifier" && ["eval", "Function"].includes(node.name) && !(parent?.type === "MemberExpression" && parent.property === node && !parent.computed)) dynamic = true;
      if (node.type === "MemberExpression" && ["prototype", "__proto__", "constructor"].includes(node.computed ? node.property?.value : node.property?.name)) dynamic = true;
      if (node.type === "CallExpression" && node.callee?.name === "Com_IncludeFile" && (node.arguments.length !== 1 || node.arguments[0]?.value !== "doclist.js")) dynamic = true;
      if (node.type === "AssignmentExpression" && node.left?.type === "MemberExpression" && ["window", "self", "globalThis"].includes(node.left.object?.name) &&
        (node.left.computed && typeof node.left.property?.value !== "string" || helperNames.has(node.left.computed ? node.left.property.value : node.left.property?.name))) dynamic = true;
      if (node.type === "CallExpression" && node.callee?.type === "MemberExpression" && ["Object", "Reflect"].includes(node.callee.object?.name) &&
        ["assign", "defineProperty", "defineProperties", "set"].includes(node.callee.property?.name) && ["window", "globalThis", "self"].includes(node.arguments[0]?.name)) dynamic = true;
    });
    if (dynamic) return undefined;
    while (gateIndex < gates.length && gates[gateIndex].start < script.start) {
      const token = gates[gateIndex++];
      if (token.closing) { if (stack.pop() !== token.name) return undefined; } else { if (token.attrs.trim()) return undefined; stack.push(token.name); }
    }
    if (stack.length > 1) return undefined;
    const matches = parsed.filter(entry => canonical(entry.ast) === canonical(script.ast));
    if (matches.length > 1) return undefined;
    if (!matches.length) {
      let unknown = false;
      walk(script.ast, (node, parent) => {
        if (node.type === "Identifier" && helperNames.has(node.name) && !(parent?.type === "MemberExpression" && parent.property === node && !parent.computed)) unknown = true;
        if (["CallExpression", "NewExpression"].includes(node.type) && node.callee?.type === "Identifier" && ["eval", "Function"].includes(node.callee.name)) unknown = true;
        if (node.type === "CallExpression" && node.callee?.name === "Com_IncludeFile" &&
          (node.arguments.length !== 1 || node.arguments[0]?.value !== "doclist.js")) unknown = true;
      });
      if (unknown) return undefined;
      continue;
    }
    const { source, ast: sourceAst } = matches[0], gate = stack[0]?.replace("xform:", "");
    if ((source.displayGate?.toLowerCase().replace("xform:", "") || undefined) !== gate || ordered.some(entry => entry.sourceRef === ref(source))) return undefined;
    ordered.push({ sourceRef: ref(source), order, gate, displayStart: script.start, displayEnd: script.end,
      sourceJavascriptSha256: hash(source.javascript), astSha256: hash(canonical(sourceAst)),
      functions: sourceAst.body.filter(node => node.type === "FunctionDeclaration").map(node => ({ name: node.id.name,
        start: node.start, end: node.end, astSha256: hash(canonical(node)) })) });
  }
  while (gateIndex < gates.length) { const token = gates[gateIndex++]; if (token.closing) { if (stack.pop() !== token.name) return undefined; } else stack.push(token.name); }
  if (stack.length || ordered.length !== sources.length) return undefined;
  return { version: 1, contract: "current-display-script-order-and-gates", displaySha256: hash(display),
    designerSha256: hash(template.fdDesignerHtml), metadataSha256: hash(template.fdMetadataXml), scripts: ordered };
}

export function validatedSharedJsonStateSourceDomain(sourceScripts = {}, entries = []) {
  const facts = sourceScripts.sources?.map(source => source.semanticFacts?.sharedJsonStateSourceDomain).filter(Boolean) || [];
  if (facts.length !== 1) return undefined;
  const domain = facts[0];
  if (domain.version !== 1 || domain.contract !== "current-display-script-order-and-gates" || domain.scripts?.length !== entries.length) return undefined;
  const usedOrders = new Set();
  for (const entry of entries) {
    const records = domain.scripts.filter(record => record.sourceRef === ref(entry.source));
    if (records.length !== 1 || !Number.isInteger(records[0].order) || usedOrders.has(records[0].order) ||
      records[0].sourceJavascriptSha256 !== hash(entry.source.javascript) || records[0].astSha256 !== hash(canonical(entry.ast)) ||
      records[0].gate !== (entry.source.displayGate?.toLowerCase().replace("xform:", "") || undefined)) return undefined;
    const functions = entry.ast.body.filter(node => node.type === "FunctionDeclaration");
    if (functions.length !== records[0].functions?.length || functions.some((node, index) => records[0].functions[index].name !== node.id.name ||
      records[0].functions[index].start !== node.start || records[0].functions[index].end !== node.end || records[0].functions[index].astSha256 !== hash(canonical(node)))) return undefined;
    usedOrders.add(records[0].order);
  }
  return domain;
}

const ast = text => { try { return parse(String(text || ""), { ecmaVersion: "latest" }); } catch { return undefined; } };
const canonical = node => JSON.stringify(node, (key, value) => ["start", "end", "raw"].includes(key) ? undefined : value);
const hash = text => createHash("sha256").update(String(text || "")).digest("hex");
const ref = source => source.sourceRef || source.id;
function walk(node, visit, parent) { if (!node || typeof node !== "object") return; visit(node, parent); for (const value of Object.values(node)) if (value && typeof value === "object") Array.isArray(value) ? value.forEach(child => walk(child, visit, node)) : walk(value, visit, node); }
