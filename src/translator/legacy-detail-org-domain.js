import { createHash } from "node:crypto";
import { parse } from "acorn";
import { scanHtmlTags, findMatchingCloseTag } from "./designer-html-tokenizer.js";
import { parseStaticMarkupAttributes } from "./source-static-markup.js";
import { parseMetadataXml } from "./sysform-metadata.js";
import { attrValue, decodeEntities, parseXmlAttributes } from "./xml-utils.js";

const hash = value => createHash("sha256").update(String(value || "")).digest("hex");
function ast(text) { try { return parse(text, { ecmaVersion: "latest" }); } catch { return undefined; } }
const canonical = value => JSON.stringify(value, (key, item) => ["start", "end", "raw"].includes(key) ? undefined : item);
const same = (left, right) => { const a = ast(left), b = ast(right); return !!a && !!b && canonical(a) === canonical(b); };
function decoded(text) {
  let value = String(text || "");
  for (let index = 0; index < 4; index += 1) { const next = decodeEntities(value); if (value === next) break; value = next; }
  return value;
}
function scripts(html) {
  const result = [];
  const text = decoded(html);
  for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const remainder = match[1].replace(/\s*(?:type|language)\s*=\s*(["\'])(?:text\/javascript|application\/javascript|javascript)\1/gi, "");
    if (remainder.trim()) return undefined;
    result.push(match[2].trim());
  }
  return result.length === [...text.matchAll(/<script\b[^>]*>/gi)].length ? result : undefined;
}

/** Scope the legacy queue to exported static form names and the existing DocList template-generation contract. */
export function legacyDetailOrgEventDomain(template = {}, sources = []) {
  if (sources.length !== 1 || !sources[0]?.javascript) return undefined;
  const source = sources[0].javascript;
  const designer = decoded(template.fdDesignerHtml), display = decoded(template.fdDisplayJsp);
  const designerScripts = scripts(designer), displayScripts = scripts(display);
  if (!designerScripts?.length || designerScripts.some(text => !same(text, source)) || !displayScripts) return undefined;
  const metadata = parseMetadataXml(template.fdMetadataXml).fields;
  const tables = metadata.filter(field => field.type === "detailTable");
  // Multiple and nested legacy generators require a separate parent-row naming proof.
  if (tables.length !== 1 || !tables[0].columns?.length) return undefined;
  const table = tables[0], tableId = table.id;
  if (!/^[A-Za-z_][\w]*$/.test(tableId)) return undefined;
  const metadataNames = new Set(metadata.flatMap(field => field.type === "detailTable"
    ? field.columns.map(column => `${field.id}.${column.id}`) : [field.id]));
  const controls = new Set(metadata.flatMap(field => field.type === "detailTable"
    ? field.columns.map(column => column.id) : [field.id]));
  const designerMarkup = String(template.fdDesignerHtml || "");
  const editorCarriers = [...scanHtmlTags(designerMarkup)].filter(token => !token.closing && token.name === "div" &&
    attrValue(token.attrs, "fd_type").toLowerCase() === "jsp").map(token => ({
      start: token.start, end: findMatchingCloseTag(designerMarkup, token.end, token.name)
    }));
  for (const token of scanHtmlTags(designerMarkup)) {
    const values = attrValue(token.attrs, "fd_values");
    const id = values.match(/(?:^|[,\s{])id\s*:\s*["']([A-Za-z_][\w]*)["']/)?.[1];
    if (/\bfd_values\s*=/i.test(token.attrs) && !id) return undefined;
    if (id) controls.add(id);
    const domId = attrValue(token.attrs, "id");
    if (/^[A-Za-z_][\w]*$/.test(domId)) controls.add(domId);
    const bindings = designerBindingAttributes(token.attrs);
    if (!bindings) return undefined;
    for (const [key, value] of bindings) {
      if (/^on/.test(key)) {
        if (safeInlineAction(key, value) || /^\s*return\s+false\s*;?\s*$/.test(value)) continue;
        if (key === "ondblclick" && token.name === "label" && editorCarriers.some(range => token.start > range.start && token.end < range.end)) {
          const attrs = parseStaticMarkupAttributes(token.attrs);
          if (attrs?.size === 3 && [...attrs.keys()].every(name => ["ondblclick", "class", "style"].includes(name)) &&
              attrs.get("class") === "button_img" && same(value, "Designer_Control_JSP_ShowEditFrame(event, this);") &&
              /^\s*background-position\s*:\s*center\s+-480px\s*;\s*margin\s*:\s*2px\s+3px\s+3px\s+2px\s*;?\s*$/i.test(attrs.get("style") || "")) continue;
        }
        return undefined;
      }
      const binding = value.match(/^extendDataFormInfo\.value\(([A-Za-z_][\w]*)(?:\.(?:!\{index\}|\d+)\.([A-Za-z_][\w]*))?(?:\.(?:id|name))?\)$/);
      if (binding) {
        const name = binding[2] ? `${binding[1]}.${binding[2]}` : binding[1];
        if (!metadataNames.has(name)) return undefined;
        controls.add(binding[2] || binding[1]);
      } else if (key.toLowerCase() === "name" && /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(value)) {
        controls.add(value);
      } else return undefined;
    }
  }
  const generated = [];
  for (const text of displayScripts) {
    if (same(text, source)) { generated.push("authored-callback"); continue; }
    if (same(text, "Com_IncludeFile('doclist.js');")) { generated.push("doclist-template-library"); continue; }
    if (same(text, `DocList_Info.push(${JSON.stringify(`TABLE_DL_${tableId}`)});`)) { generated.push("doclist-static-table-registration"); continue; }
    const count = text.match(/i\s*<\s*(\d+)/)?.[1];
    if (count && Number(count) <= 100 && same(text, `Com_AddEventListener(window,'load',function(){setTimeout(function(){for(var i=0;i<${count};i++){DocList_AddRow(document.getElementById(${JSON.stringify(`TABLE_DL_${tableId}`)}))};},500);});`)) {
      generated.push("doclist-static-default-rows"); continue;
    }
    const width = `$(function(){var tb=document.getElementById(${JSON.stringify(`TABLE_DL_${tableId}`)});var totalWidth=0;var tds=$(tb).find("tr[type='titleRow']").children();var hasPercent=false;tds.each(function(){if(!this.width||this.width+''.indexOf('%')>=0){totalWidth+=$(this).width();hasPercent=true;}else{totalWidth+=parseInt(this.width);}});var tdWidth=$(tb).parents('td').width();if(!hasPercent&&totalWidth>tdWidth)$(tb).css('width',totalWidth+'px');var tb_div=document.getElementById(${JSON.stringify(`TABLE_DL_${tableId}_div`)});$(tb_div).css('width','null');});`;
    if (same(text, width)) { generated.push("doclist-static-width-only"); continue; }
    return undefined;
  }
  if (displayScripts.length && (!generated.includes("authored-callback") ||
      !generated.includes("doclist-template-library") || !generated.includes("doclist-static-table-registration"))) return undefined;
  let names = 0;
  const foreach = [...scanHtmlTags(display)].filter(token => token.name === "c:foreach" && !token.closing);
  if (foreach.some(token => { const attrs = parseXmlAttributes(token.attrs); return attrs.items !== `\${_xformForm.extendDataFormInfo.formData.${tableId}}` || attrs.var !== "_xformEachBean" || attrs.varStatus !== "vstatus"; })) return undefined;
  for (const token of scanHtmlTags(display)) {
    const attrs = parseXmlAttributes(token.attrs);
    const eventKeys = [...token.attrs.matchAll(/(?:^|\s)(on[\w]+)\s*=/gi)].map(match => match[1]);
    if (eventKeys.some(key => !Object.hasOwn(attrs, key))) return undefined;
    for (const [key, value] of Object.entries(attrs)) {
      if (/^on/i.test(key)) {
        if (safeInlineAction(key.toLowerCase(), value)) continue;
        return undefined;
      }
      if (!["property", "propertyId", "propertyName", "name"].includes(key) || !["input", "select", "textarea"].includes(token.name) && !token.name.startsWith("xform:")) continue;
      if (!value.startsWith("extendDataFormInfo.value(")) return undefined;
      if (value.includes("${vstatus.index}") && foreach.length !== 1) return undefined;
      const normalized = value.replace("${vstatus.index}", "!{index}");
      const match = normalized.match(/^extendDataFormInfo\.value\(([A-Za-z_][\w]*(?:\.!\{index\}\.[A-Za-z_][\w]*)?)(?:\.(?:id|name))?\)$/);
      if (!match) return undefined;
      const name = match[1].replace(".!{index}.", ".");
      if (!metadataNames.has(name) && name !== `${tableId}.fdId`) return undefined;
      names += 1;
    }
  }
  if (displayScripts.length && names === 0) return undefined;
  return { version: 1, scope: "current-export-static-doclist-controls", tableId,
    sourceJavascriptSha256: hash(source), designerSha256: hash(template.fdDesignerHtml),
    displaySha256: hash(template.fdDisplayJsp), metadataSha256: hash(template.fdMetadataXml),
    designerScriptCount: designerScripts.length, displayScriptCount: displayScripts.length,
    displayScriptKinds: generated, sourceControlIds: [...controls].sort() };
}

// Inspect attribute slots without interpreting names embedded in an opaque
// legacy fd_values/value attribute (which can itself contain JavaScript).
function designerBindingAttributes(text) {
  const result = new Map();
  let offset = 0;
  while (offset < text.length) {
    if (!/[A-Za-z_:]/.test(text[offset])) { offset += 1; continue; }
    const match = text.slice(offset).match(/^([A-Za-z_:][\w:.-]*)/);
    const key = match[1].toLowerCase();
    offset += match[0].length;
    while (/\s/.test(text[offset] || "")) offset += 1;
    if (text[offset] !== "=") continue;
    offset += 1;
    while (/\s/.test(text[offset] || "")) offset += 1;
    const quote = ["\"", "'"].includes(text[offset]) ? text[offset++] : undefined;
    const start = offset;
    if (quote) {
      while (offset < text.length && text[offset] !== quote) offset += 1;
      if (offset === text.length) return undefined;
    } else while (offset < text.length && !/\s/.test(text[offset])) offset += 1;
    const value = text.slice(start, offset);
    if (quote) offset += 1;
    if (!["name", "property", "propertyid", "propertyname"].includes(key) && !/^on/.test(key)) continue;
    if (result.has(key)) return undefined;
    result.set(key, decodeEntities(value));
  }
  return result;
}

function safeInlineAction(key, value) {
  return key === "onvaluechange" && value === "__xformDispatch" || key === "onclick" && [
    "DocList_AddRow();XFom_RestValidationElements();",
    "DocList_DeleteRow_ClearLast();XFom_RestValidationElements();",
    "DocList_MoveRow(-1);", "DocList_MoveRow(1);"
  ].includes(value);
}
