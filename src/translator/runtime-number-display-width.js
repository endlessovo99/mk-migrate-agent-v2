import { isVoidLikeTag, scanHtmlTags } from "./designer-html-tokenizer.js";
import { parseDesignerFdValues } from "./designer-control-values.js";
import { parseStaticMarkupAttributes as parseAttributes, staticSourceMarkup as visibleMarkup } from "./source-static-markup.js";

const px = value => {
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(String(value ?? ""));
  const number = match && Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};
const decorated = object => Object.entries(object || {}).some(([key, value]) =>
  /prefix|suffix/i.test(key) && value !== undefined && value !== null && value !== "");

/** Record a fixed source value width. Native shell sizing is not source evidence. */
export function annotateRuntimeNumberDisplayWidth(fields, runtimeHtml, metadataFields, designerHtml, layout) {
  const runtime = visibleMarkup(String(runtimeHtml || "")), designer = visibleMarkup(String(designerHtml || ""));
  if (runtime === undefined || designer === undefined) return fields;
  const renderings = runtimeEntries(runtimeHtml, runtime);
  if (!renderings) return fields;
  const controls = [...scanHtmlTags(designer)].filter(token => !token.closing && parseDesignerFdValues(token.attrs).id);
  const cells = (layout?.rows || []).flatMap(row => row.cells || []);
  return fields.map(field => {
    const source = field.source || {}, values = source.designerValues || {}, width = px(values.width);
    if (field.type !== "number" || field.dataOnly || values.dataType !== "Double" ||
        !["calculation", "inputText"].includes(source.designerType) ||
        String(values.readOnly).trim().toLowerCase() !== "true" || source.layoutCell?.hiddenLabel !== true ||
        !width || source.designerId !== field.id || values.id !== field.id ||
        decorated(source) || decorated(values)) return field;
    const metadata = metadataFields.filter(item => item.id === field.id);
    const attributes = source.metadataAttributes || {};
    if (metadata.length !== 1 || source.metadataId !== field.id || source.metadataKind !== "simple" ||
        attributes.kind !== "simple" || attributes.name !== field.id || attributes.type !== "Double" ||
        Object.hasOwn(attributes, "width") && px(attributes.width) !== width) return field;
    const matchingControls = controls.filter(token => parseDesignerFdValues(token.attrs).id === field.id);
    const matchingCells = cells.filter(cell => (cell.fieldIds || [cell.fieldId]).includes(field.id));
    const matches = renderings.get(field.id) || [];
    if (matchingControls.length !== 1 || matchingCells.length !== 1 || matches.length !== 1 ||
        styleWidth(parseAttributes(matchingControls[0].attrs)) !== width) return field;
    const flow = matchingCells[0].contentFlow;
    const items = (flow?.items || []).filter(item => item.referenceId === field.id);
    if (items.length !== 1 || items[0].width?.unit !== "px" || items[0].width.value !== width ||
        flow.lines.flat().filter(id => id === field.id).length !== 1 || matches[0].valuePx !== width) return field;
    return { ...field, source: { ...source, runtimeNumberDisplayWidth: matches[0] } };
  });
}

function runtimeEntries(original, html) {
  const result = new Map(), ancestors = [];
  for (const token of scanHtmlTags(html)) {
    if (token.closing) {
      const index = ancestors.findLastIndex(ancestor => ancestor.name === token.name);
      if (index < 0) return undefined;
      ancestors.splice(index);
      continue;
    }
    const attributes = parseAttributes(token.attrs);
    if (!attributes && (token.name === "xform:xtext" || /(?:^|\s)property\s*=/i.test(token.attrs))) return undefined;
    const property = attributes?.get("property");
    if (property !== undefined) {
      const canonical = property.match(/^extendDataFormInfo\.value\(([A-Za-z_][\w-]*)\)$/)?.[1];
      // A possible main binding poisons uniqueness; only the exact canonical form can grant evidence.
      const id = canonical || property.match(/^extendDataFormInfo\s*\.\s*value\s*\(\s*([A-Za-z_][\w-]*)\s*\)$/)?.[1];
      if (id) {
        const entries = result.get(id) || [];
        // Invalid matches remain in the collection; they must not disappear before uniqueness checks.
        const properties = parseAttributes(attributes.get("htmlelementproperties") || "");
        const width = styleWidth(attributes);
        const safe = canonical && token.name === "xform:xtext" && token.selfClosing && width && properties?.has("readonly") &&
          ["", "true"].includes(properties.get("readonly").toLowerCase()) &&
          [...attributes.keys()].every(key => ["property", "style", "showstatus", "showlabel", "htmlelementproperties", "datatype", "editreadonlystyle", "subject", "title", "isloaddatadict"].includes(key)) &&
          [undefined, "Double"].includes(attributes.get("datatype")) &&
          [undefined, "", "inputsgl"].includes(attributes.get("editreadonlystyle")) &&
          [undefined, "false"].includes(attributes.get("isloaddatadict")?.toLowerCase()) &&
          [undefined, "", "false"].includes(attributes.get("showlabel")?.toLowerCase()) &&
          knownShowStatus(attributes.get("showstatus")) &&
          [...properties.keys()].every(key => ["readonly", "calculation", "isrow", "expression", "autocalculate", "thousandshow", "scale", "defaultvalue", "recalculate"].includes(key)) &&
          !/<%/.test(String(original).slice(token.start, token.end)) &&
          !ancestors.some(ancestor => ancestor.uncertain ||
            !["table", "thead", "tbody", "tfoot", "tr", "td", "th"].includes(ancestor.name) && ancestor.sized);
        entries.push(safe ? {
          source: "fdDisplayJsp", renderer: "xform:xtext", property: attributes.get("property"),
          valuePx: width, readOnly: true, offset: token.start,
          ancestorOffsets: ancestors.map(ancestor => ({ tag: ancestor.name, offset: ancestor.start }))
        } : {});
        result.set(id, entries);
      }
    }
    if (!token.selfClosing && !isVoidLikeTag(token.name)) {
      const style = attributes?.get("style") || "";
      ancestors.push({ name: token.name, start: token.start, uncertain: !attributes ||
        ["c:choose", "c:foreach", "c:if", "c:otherwise", "c:when", "xform:editshow", "xform:viewshow"].includes(token.name) ||
        /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))/i.test(style) || attributes.has("hidden"), sized: !attributes ||
        attributes.has("width") || /(?:^|;)\s*width\s*:/i.test(style) || uncertainStyle(style) });
    }
  }
  return ancestors.length ? undefined : result;
}

function styleWidth(attributes) {
  if (!attributes || attributes.has("width")) return undefined;
  const style = attributes.get("style") || "";
  if (uncertainStyle(style)) return undefined;
  if (style.split(";").some(part => part.trim() && !/^\s*(?:width\s*:|display\s*:\s*inline\s*$)/i.test(part))) return undefined;
  const widths = style.split(";").filter(item => /^\s*width\s*:/i.test(item));
  const match = widths.length === 1 && /^\s*width\s*:\s*(\d+(?:\.\d+)?)px\s*$/i.exec(widths[0]);
  return match ? px(match[1]) : undefined;
}
function knownShowStatus(value) {
  return value === undefined || value === "" || /^\$\{requestScope\[(["'])SysForm\.showStatus\1\]\}$/.test(value);
}
function uncertainStyle(style) {
  return /\/\*|\*\/|[\\{}<>]/.test(style) || style.split(";").some(part =>
    part.trim() && !/^\s*[-a-z]+\s*:[^:]*$/i.test(part));
}
