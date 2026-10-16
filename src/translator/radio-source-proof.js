import { scanHtmlTags, isVoidLikeTag } from "./designer-html-tokenizer.js";
import { parseStaticMarkupAttributes } from "./source-static-markup.js";
import { cleanText, decodeEntities } from "./xml-utils.js";
import { parseStaticDesignerStringValues } from "./designer-control-values.js";

const RADIO_VALUE_KEYS = new Set(["id", "_label_bind", "label", "_label_bind_id", "canShow", "required", "readOnly", "alignment", "dataType", "items", "formula", "defaultValue", "reCalculate", "width"]);

export function sourceRadioLiteralValues(attrs) {
  return parseStaticDesignerStringValues(attrs, RADIO_VALUE_KEYS, new Set(["items"]));
}

export function sourceRadioGroupingValues(attrs) {
  // A static label's line breaks do not change option grouping. Width proof
  // deliberately retains its stricter appearance contract above.
  return parseStaticDesignerStringValues(attrs, RADIO_VALUE_KEYS, new Set(["items", "label"]));
}

/** Complete editor face; count-only matching must not erase unknown content. */
export function radioFaceMatches(body, values, options) {
  const root = { children: [], text: "" }, stack = [root]; let offset = 0;
  for (const token of scanHtmlTags(body)) {
    stack.at(-1).text += body.slice(offset, token.start); offset = token.end;
    if (token.closing) {
      if (stack.length < 2 || stack.at(-1).name !== token.name) return false;
      stack.pop(); continue;
    }
    const attrs = parseStaticMarkupAttributes(token.attrs);
    if (!attrs) return false;
    const node = { name: token.name, attrs, text: "", children: [] };
    stack.at(-1).children.push(node);
    if (!token.selfClosing && !isVoidLikeTag(token.name)) stack.push(node);
  }
  stack.at(-1).text += body.slice(offset);
  if (stack.length !== 1) return false;
  const blank = text => decodeEntities(text).trim() === "";
  const only = (node, name) => blank(node.text) && node.children.length === 1 && node.children[0].name === name ? node.children[0] : undefined;
  const tbody = only(root, "tbody"), tr = tbody && only(tbody, "tr"), td = tr && only(tr, "td");
  if (!td || [tbody, tr, td].some(node => node.attrs.size || !blank(node.text))) return false;
  const entries = [...td.children], marker = entries.at(-1)?.name === "span" ? entries.pop() : undefined;
  if (marker && (values.required !== "true" || marker.children.length || marker.text.trim() !== "*" || marker.attrs.size !== 1 ||
      !(marker.attrs.get("class") === "txtstrong" || /^\s*color\s*:\s*red\s*;?\s*$/i.test(marker.attrs.get("style") || "")))) return false;
  const count = options.length, vertical = values.alignment === "V";
  if (entries.length !== count + (vertical ? count - 1 : 0)) return false;
  for (let index = 0; index < count; index++) {
    const nobr = entries[vertical ? index * 2 : index];
    if (nobr.name !== "nobr" || nobr.attrs.size || !blank(nobr.text) || nobr.children.length !== 2) return false;
    const [input, label] = nobr.children, option = options[index];
    const inputKeys = new Set(["id", "type", "value", "attach", "label", "tablename", "_required", "required", "itemvalues", "items", "alignment", "defaultvalue"]);
    if (input.name !== "input" || input.children.length || input.text || [...input.attrs.keys()].some(key => !inputKeys.has(key)) ||
        input.attrs.get("id") !== values.id || input.attrs.get("type")?.toLowerCase() !== "radio" || input.attrs.get("value") !== option.value ||
        input.attrs.has("attach") && input.attrs.get("attach") !== values.id ||
        ["required", "_required"].some(key => input.attrs.has(key) && input.attrs.get(key) !== values.required) ||
        input.attrs.has("alignment") && input.attrs.get("alignment") !== values.alignment ||
        input.attrs.has("defaultvalue") && input.attrs.get("defaultvalue") !== values.defaultValue ||
        label.name !== "label" || label.children.length || label.attrs.size !== 1 || label.attrs.get("attach") !== values.id ||
        cleanText(label.text) !== option.label) return false;
    if (vertical && index < count - 1) {
      const br = entries[index * 2 + 1];
      if (br.name !== "br" || br.attrs.size || br.children.length || br.text) return false;
    }
  }
  return true;
}
