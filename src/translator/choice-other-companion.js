import { isSourceDescriptionControl } from "./source-description-control.js";
import { cleanText } from "./xml-utils.js";
import { captionScriptReferences } from "./caption-script-references.js";
import { createHash } from "node:crypto";
import { parse } from "acorn";
import { isNativeOtherLabel } from "../dsl/native-other-checkbox.js";
import { choiceOtherBehaviorInputs } from "./choice-other-programs.js";

/**
 * Records same-cell radio/checkbox other-choice + free-text evidence as a
 * source fact. Target folding belongs at the DSL mapping seam.
 */
export function annotateChoiceOtherCompanions(controls = []) {
  for (let index = 0; index < controls.length; index += 1) {
    const choice = controls[index];
    if (!isSourceChoiceControl(choice) || choice.source?.otherTextCompanion) continue;
    const otherOptions = (choice.options || []).filter((option) => isOtherCaptionText(option.label));
    if (otherOptions.length > 1) continue;

    let offset = index + 1;
    let caption;
    if (offset < controls.length && isOtherCaptionControl(controls[offset])) {
      caption = controls[offset];
      offset += 1;
    }
    const companion = controls[offset];
    if (!isOtherTextCompanion(companion)) continue;
    if (!caption && (!otherOptions.length || !hasMatchingOtherTitle(choice, companion))) continue;

    choice.source = {
      ...choice.source,
      otherTextCompanion: {
        id: companion.id,
        otherRequired: companion.required === true,
        ...(otherOptions.length ? { optionValue: otherOptions[0].value, optionLabel: otherOptions[0].label } : {}),
        ...(caption
          ? {
              captionId: caption.id,
              caption: cleanText(caption.title || caption.source?.designerValues?.content || "")
            }
          : {})
      }
    };
  }
  return controls;
}

/** Map source checkbox/radio Other companions to MK's native Other option. */
export function mapChoiceOtherCompanions(fields = [], sourceScripts = {}, behavior, dependentSource = {}) {
  const replacements = new Map();
  const pairs = fields.filter(field => ["xform-checkbox", "xform-radio"].includes(field.componentId) &&
    field.sourceProps?.otherTextCompanion?.id);
  for (const choice of pairs) {
    const relation = choice.sourceProps.otherTextCompanion;
    const text = fields.find(field => field.id === relation.id);
    const caption = relation.captionId ? fields.find(field => field.id === relation.captionId) : undefined;
    if (relation.captionId && pairs.filter(field => field.sourceProps.otherTextCompanion.captionId === relation.captionId).length !== 1 ||
        !text || text.componentId !== "xform-input" || text.dataOnly ||
        relation.captionId && (!caption || caption.componentId !== "xform-description" || caption.dataOnly ||
          !(isOtherCaptionText(caption.props?.content || caption.title) || relation.crossCell?.version === 1 &&
            cleanText(caption.props?.content || caption.title) === relation.caption && /^(?:其他|其它).{2,}$/u.test(relation.caption))) ||
        !relation.captionId && relation.optionValue === undefined ||
        relation.crossCell?.version === 1 && referencedText(text, sourceScripts, fields) ||
        caption && referencedCaption(caption, choice, sourceScripts, fields, behavior)) continue;
    const options = choice.props?.options || [], noteDefault = text.props?.defaultValue, choiceDefault = choice.props?.defaultValue;
    const dependenciesUnproven = hasDependentReference(dependentSource,
      [choice.id, text.id, caption?.id, choice.title, text.title].filter(value => typeof value === "string" && value.trim().length > 0));
    const scriptPrograms = choiceOtherBehaviorInputs(sourceScripts, fields);
    const pairContext = choice.sourceProps?.otherPairContext ||
      caption?.sourceProps?.staticCaptionFact?.domContext || caption?.sourceProps?.captionStructure?.domContext;
    const knownDigests = new Set(scriptPrograms.map(value => createHash("sha256").update(value.trim()).digest("hex")));
    if (!Array.isArray(options) || !options.length || options.some(option =>
      typeof option.value !== "string" || !option.value || /[,\r\n]/.test(option.value) ||
      option.value.startsWith("other_") || option.type === "other") ||
      referencedText(choice, sourceScripts, fields) || referencedText(text, sourceScripts, fields) ||
      pairContext?.inlineScriptDigests?.some(digest => !knownDigests.has(digest)) ||
      !caption && scriptPrograms.length > 0 && (!pairContext || !behavior?.forPair(choice.id, text.id, pairContext).ok) ||
      dependenciesUnproven ||
      text.props?.readOnly === true && choice.props?.readOnly !== true ||
      noteDefault && (noteDefault.kind !== "literal" || typeof noteDefault.value !== "string") ||
      choiceDefault && (choiceDefault.kind !== "literal" || typeof choiceDefault.value !== "string") ||
      relation.optionValue !== undefined && !options.some(option => option.value === relation.optionValue)) continue;
    const label = cleanText(relation.optionLabel || caption?.title).replace(/[:：]\s*$/u, "");
    const regular = options.filter(option => option.value !== relation.optionValue);
    const defaults = choiceDefault?.value ? choiceDefault.value.split(",") : [];
    if (defaults.some(value => !options.some(option => option.value === value)) || new Set(defaults).size !== defaults.length ||
        choice.componentId === "xform-radio" && defaults.length > 1) continue;
    const mappedDefaults = defaults.filter(value => value !== relation.optionValue);
    if (defaults.includes(relation.optionValue) || noteDefault?.value) mappedDefaults.push(`other_${noteDefault?.value || ""}`);
    if (choice.componentId === "xform-radio" && mappedDefaults.length > 1) continue;
    if (mappedDefaults.length && regular.some(option => option.value === "0")) continue;
    replacements.set(choice.id, { ...choice,
      props: { ...choice.props, options: [...regular, { label, value: "other_", type: "other",
        ...(text.props?.required === true ? { isRequired: true } : {}) }],
        ...(mappedDefaults.length ? { defaultValue: { kind: "literal", value: mappedDefaults.join(",") } } : {}) },
      nativeOther: { version: 1, captionSourceRef: caption?.sourceRef || null, textSourceRef: text.sourceRef }
    });
    if (caption) replacements.set(caption.id, { ...caption, dataOnly: true });
    replacements.set(text.id, { ...text, dataOnly: true, props: { ...text.props, required: false } });
  }
  for (const choice of fields.filter(field => ["xform-checkbox", "xform-radio"].includes(field.componentId) &&
      field.dataOnly !== true && field.sourceProps?.hardHidden !== true && !field.sourceProps?.otherTextCompanion && Array.isArray(field.props?.options))) {
    const options = choice.props.options, others = options.filter(option => isNativeOtherLabel(option?.label));
    if (others.length !== 1 || options.some(option => typeof option.value !== "string" || !option.value ||
        /[,\r\n]/.test(option.value) || option.value.startsWith("other_") || option.type === "other") ||
        referencedText(choice, sourceScripts, fields) ||
        hasDependentReference(dependentSource, [choice.id, choice.title].filter(value => typeof value === "string" && value.trim().length > 0))) continue;
    const programs = [...choiceOtherBehaviorInputs(sourceScripts, fields),
      ...(sourceScripts.fragments || []).map(fragment => fragment.content),
      ...(sourceScripts.actions || []).map(action => action.function || action.sourceText)]
      .filter(value => typeof value === "string" && value.trim());
    if (programs.length && captionScriptReferences(programs).opaque) continue;
    const context = choice.sourceProps?.otherPairContext || choice.sourceProps?.staticCaptionFact?.domContext || choice.sourceProps?.captionStructure?.domContext;
    if (programs.length && (!context || !behavior?.forPair(choice.id, choice.id, context).ok)) continue;
    const other = others[0], defaults = choice.props.defaultValue;
    if (defaults && (defaults.kind !== "literal" || typeof defaults.value !== "string")) continue;
    const values = defaults?.value ? defaults.value.split(",") : [];
    if (values.some(value => !options.some(option => option.value === value)) || new Set(values).size !== values.length ||
        choice.componentId === "xform-radio" && values.length > 1) continue;
    const mapped = values.map(value => value === other.value ? "other_" : value);
    replacements.set(choice.id, { ...choice, props: { ...choice.props,
      options: [...options.filter(option => option !== other), { label: other.label, value: "other_", type: "other" }],
      ...(defaults ? { defaultValue: { kind: "literal", value: mapped.join(",") } } : {})
    }, nativeOther: { version: 2, sourceOptionValue: other.value } });
  }
  return fields.map(field => replacements.get(field.id) || field);
}

/** Check the structured workflow, including JSON stored inside robot content. */
function hasDependentReference(source, ids) {
  function inspect(value, key, depth) {
    if (depth > 32) return true;
    if (Array.isArray(value)) return value.some(item => inspect(item, key, depth + 1));
    if (value && typeof value === "object") return Object.entries(value).some(([name, item]) =>
      ids.some(id => name.includes(id)) || inspect(item, name, depth + 1));
    if (typeof value !== "string") return false;
    let decoded = value;
    for (let round = 0; round < 8; round++) {
      if (ids.some(id => decoded.includes(id))) return true;
      const next = decoded.replace(/\\u([0-9a-f]{4})/gi, (_, digits) => String.fromCharCode(parseInt(digits, 16)))
        .replace(/\\x([0-9a-f]{2})/gi, (_, digits) => String.fromCharCode(parseInt(digits, 16)));
      if (next === decoded) break;
      decoded = next;
    }
    if (ids.some(id => decoded.includes(id)) || /\\(?:u[0-9a-f]{4}|x[0-9a-f]{2})/i.test(decoded)) return true;
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 2_000_000) {
      try { return inspect(JSON.parse(trimmed), key, depth + 1); }
      catch { return key === "content" || /^(?:script|formula|expression|condition)$/i.test(key || ""); }
    }
    if (trimmed.length > 2_000_000 && (key === "content" || /^(?:script|formula|expression|condition)$/i.test(key || ""))) return true;
    return /(?:content|script|formula|expression|condition)/i.test(key || "") && expressionReferenceUnproven(decoded, ids);
  }
  return inspect(source, "", 0);
}

function expressionReferenceUnproven(source, ids) {
  let ast;
  const normalized = source.replace(/\$[^${}\r\n]+\$/g, "__mk_source_token");
  try { ast = parse(normalized, { ecmaVersion: "latest", allowReturnOutsideFunction: true }); }
  catch { return /[()[\]{};`]|\b(?:eval|Function|fromCharCode)\b/.test(source); }
  let unsafe = false;
  function constant(node) {
    if (node?.type === "Literal" && ["string", "number"].includes(typeof node.value)) return String(node.value);
    if (node?.type === "BinaryExpression" && node.operator === "+") {
      const left = constant(node.left), right = constant(node.right);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (node?.type === "TemplateLiteral") {
      const parts = node.expressions.map(constant);
      return parts.some(value => value === undefined) ? undefined : node.quasis.map((item, index) => item.value.cooked + (parts[index] || "")).join("");
    }
    return undefined;
  }
  function visit(node, parent) {
    if (!node || typeof node !== "object" || unsafe) return;
    const value = constant(node);
    if (value !== undefined && ids.some(id => value.includes(id))) { unsafe = true; return; }
    if (node.type === "Identifier" && ["eval", "Function", "fromCharCode"].includes(node.name)) { unsafe = true; return; }
    if (node.type === "Identifier" && node.name === "MKXFORM" &&
        !(parent?.type === "MemberExpression" && parent.object === node)) { unsafe = true; return; }
    if (node.type === "MemberExpression" && node.object?.name === "MKXFORM" &&
        !(parent?.type === "CallExpression" && parent.callee === node)) { unsafe = true; return; }
    if (node.type === "CallExpression") {
      const callee = node.callee, name = callee?.type === "Identifier" ? callee.name :
        callee?.type === "MemberExpression" && !callee.computed ? callee.property?.name : "";
      if (/get.*field|field.*get/i.test(name || "") || ["getValue", "setValue", "getFormValues"].includes(name)) {
        if (!node.arguments.length || constant(node.arguments[0]) === undefined) { unsafe = true; return; }
      } else if (!(callee?.type === "Identifier" && ["__mk_source_token", "Number", "String", "Boolean", "parseInt", "parseFloat", "isFinite", "isNaN"].includes(name)) &&
          !(callee?.type === "MemberExpression" && callee.object?.name === "__mk_source_token" && name === "equals" &&
            node.arguments.length === 1 && constant(node.arguments[0]) !== undefined) &&
          !(callee?.type === "MemberExpression" && callee.object?.name === "Math" && ["abs", "ceil", "floor", "round", "min", "max"].includes(name))) {
        unsafe = true; return;
      }
    }
    if (node.type === "MemberExpression" && node.computed && constant(node.property) === undefined) { unsafe = true; return; }
    for (const item of Object.values(node)) if (item && typeof item === "object") {
      if (Array.isArray(item)) item.forEach(child => visit(child, node)); else visit(item, node);
    }
  }
  visit(ast);
  return unsafe;
}

function referencedCaption(caption, choice, scripts, fields, behavior) {
  const texts = sourceScriptTexts(scripts, fields);
  const references = captionScriptReferences(texts);
  if (texts.some(text => text.includes(caption.id)) || references.values.some(text => text.includes(caption.id))) return true;
  if (references.opaque && !scripts.sources?.length && scripts.fragments?.length) return true;
  const context = caption.sourceProps?.captionStructure?.domContext || caption.sourceProps?.staticCaptionFact?.domContext;
  const impact = behavior?.forPair(choice.id, caption.id, context);
  return impact ? !impact.ok : references.opaque;
}

function referencedText(text, scripts, fields) {
  const texts = sourceScriptTexts(scripts, fields), refs = captionScriptReferences(texts);
  return texts.some(value => value.includes(text.id)) || refs.values.some(value => value.includes(text.id));
}

function sourceScriptTexts(scripts, fields) {
  return [...(scripts.sources || []).flatMap(source => [source.javascript, source.helperJavascript]),
    ...(scripts.fragments || []).map(fragment => fragment.content),
    ...(scripts.actions || []).map(action => action.function || action.sourceText),
    ...fields.flatMap(field => [
      ...Object.entries(field.sourceProps?.designerValues || {}).filter(([key]) => /^(?:on|script|function|event)/i.test(key)).map(([, value]) => value),
      ...(field.sourceProps?.captionStructure?.domContext?.inlineScripts || field.sourceProps?.staticCaptionFact?.domContext?.inlineScripts || [])
    ])].filter(text => typeof text === "string" && text.trim());
}

function isSourceChoiceControl(control) {
  const designerType = String(control?.source?.designerType || "").toLowerCase();
  return ["checkbox", "radio", "singleSelect"].includes(control?.type) ||
    ["inputcheckbox", "checkbox", "inputradio", "radio", "select", "inputselect"].includes(designerType);
}

function isOtherCaptionControl(control) {
  if (!isSourceDescriptionControl(control)) return false;
  return isOtherCaptionText(control.title || control.source?.designerValues?.content || "");
}

function isOtherTextCompanion(companion) {
  if (!companion || companion.type === "detailTable") return false;
  if (isSourceChoiceControl(companion) || isSourceDescriptionControl(companion)) return false;
  const designerType = String(companion.source?.designerType || "").toLowerCase();
  if (companion.type !== "text" && !["inputtext", "text"].includes(designerType)) return false;
  if (companion.source?.hardHidden === true) return false;
  return true;
}

function isOtherCaptionText(value) {
  return /^(?:(?:\d+\s*[.．、)）]|[（(]\d+[）)]\s*[.．、]?)\s*)?(?:其他|其它)(?:附件|方式)?\s*(?:[（(][^）)]*[）)])?\s*[:：]?$/u.test(cleanText(value));
}

function hasMatchingOtherTitle(choice, companion) {
  const title = cleanText(companion.title || companion.source?.designerValues?.label || "");
  if (isOtherCaptionText(title)) return true;
  const titles = new Set([choice.source?.boundCaption?.content, choice.title, choice.source?.designerValues?.label]
    .map(value => cleanText(value || "").replace(/[:：]\s*$/u, "")).filter(Boolean));
  const hasOtherMethod = (choice.options || []).some(option => /^(?:其他|其它)方式$/u.test(cleanText(option.label)));
  return [...titles].some(choiceTitle => (
    title.startsWith(choiceTitle) && (
      isOtherCaptionText(title.slice(choiceTitle.length).replace(/^\s*[:：\-—－–]\s*/u, "")) ||
      hasOtherMethod && /^qt$/i.test(title.slice(choiceTitle.length).trim())
    ) ||
    title.endsWith(choiceTitle) && isOtherCaptionText(title.slice(0, -choiceTitle.length))
  ));
}
