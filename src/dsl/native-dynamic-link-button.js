import {parse} from 'acorn';
import {canonicalJson} from '../agent-review/digest.js';
import {hasVerifiedDeterministicScriptBranchProof} from './deterministic-script-translations.js';

export const DYNAMIC_LINK_BUTTON_KIND='native-dynamic-link-button';
const id=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,24}$/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
const ref=value=>typeof value==='string'&&value.length>0&&value.length<500&&!/[\r\n]/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function nativeDynamicLinkClick(spec){
 return `function onClick() {\n  var spec = ${canonicalJson(spec)};\n  var form = MKXFORM.$$FORM && MKXFORM.$$FORM.current;\n  var state = form && Object.getOwnPropertyDescriptor(form, "__mkDynamicLinkSnapshotV1");\n  if (!state || !state.value || Object.getPrototypeOf(state.value) !== null) return;\n  var entry = Object.getOwnPropertyDescriptor(state.value, spec.buttonId);\n  var url = entry && typeof entry.value === "string" ? entry.value : "";\n  if (url && spec.target === "_blank") window.open(url, "_blank", "noopener");\n  else if (url) window.open(url, "_self");\n}`;
}
export function nativeDynamicLinkVisibility(spec){
 return `function onLoad() {\n  var spec = ${canonicalJson(spec)};\n  MKXFORM.setFieldAttr(${JSON.stringify(spec.buttonId)}, 4);\n  var form = MKXFORM.$$FORM && MKXFORM.$$FORM.current;\n  if (!form || typeof form !== "object") return;\n  var value = MKXFORM.getValue(spec.urlFieldId);\n  var url = value == null ? "" : String(value);\n  var state = Object.getOwnPropertyDescriptor(form, "__mkDynamicLinkSnapshotV1");\n  if (!state) {\n    Object.defineProperty(form, "__mkDynamicLinkSnapshotV1", { value: Object.create(null) });\n    state = Object.getOwnPropertyDescriptor(form, "__mkDynamicLinkSnapshotV1");\n  }\n  if (!state || !state.value || Object.getPrototypeOf(state.value) !== null) return;\n  state.value[spec.buttonId] = url;\n  if (url) MKXFORM.setFieldAttr(${JSON.stringify(spec.buttonId)}, 5);\n}`;
}
function inspectNativeDynamicLinkFunction(source, name, render){
 if(typeof source!=='string'||!source.startsWith(`function ${name}() {\n  var spec = `))return;
 try{const ast=parse(source,{ecmaVersion:'latest'}),fn=ast.body[0],decl=fn?.body?.body?.[0]?.declarations?.[0];if(ast.body.length!==1||fn?.id?.name!==name||decl?.id?.name!=='spec')return;const spec=JSON.parse(source.slice(decl.init.start,decl.init.end));if(!exact(spec,['buttonId','sourceRef','target','urlFieldId'])||!id(spec.buttonId)||!id(spec.urlFieldId)||!ref(spec.sourceRef)||!['_self','_blank'].includes(spec.target)||render(spec)!==source)return;return spec;}catch{return;}
}
export const inspectNativeDynamicLinkClick = source => inspectNativeDynamicLinkFunction(source, 'onClick', nativeDynamicLinkClick);
export const inspectNativeDynamicLinkVisibility = source => inspectNativeDynamicLinkFunction(source, 'onLoad', nativeDynamicLinkVisibility);
export function nativeDynamicLinkDslDiagnostics(dsl) {
  const diagnostics = [];
  const actions = Array.isArray(dsl?.scripts?.actions) ? dsl.scripts.actions : [];
  const decisions = (dsl?.migrationPolicies?.decisions || []).filter(item => item?.kind === DYNAMIC_LINK_BUTTON_KIND);
  const audits = (dsl?.migrationPolicyAudit?.audits || []).filter(item => item?.kind === DYNAMIC_LINK_BUTTON_KIND);
  const fail = sourceRef => diagnostics.push({ level: "error", code: "dsl.native_dynamic_link_profile_invalid", path: "/scripts/actions", message: "Dynamic link buttons require the exact source-bound approved policy, field identities, visibility and handler.", details: { sourceRef } });
  const refs = new Set([
    ...decisions.map(item => item.sourceRef),
    ...audits.map(item => item.sourceRef),
    ...actions.map(action => action?.semanticHints?.approvedNativeDynamicLink?.sourceRef).filter(Boolean),
    ...actions.map(action => inspectNativeDynamicLinkClick(action?.function)?.sourceRef).filter(Boolean),
    ...actions.map(action => inspectNativeDynamicLinkVisibility(action?.function)?.sourceRef).filter(Boolean)
  ]);
  for (const sourceRef of refs) {
    const selected = decisions.filter(item => item.sourceRef === sourceRef);
    const records = audits.filter(item => item.sourceRef === sourceRef);
    const related = actions.filter(item => item?.semanticHints?.approvedNativeDynamicLink?.sourceRef === sourceRef || inspectNativeDynamicLinkClick(item?.function)?.sourceRef === sourceRef || inspectNativeDynamicLinkVisibility(item?.function)?.sourceRef === sourceRef);
    if (selected.length !== 1 || records.length !== 1 || related.length !== 2) { fail(sourceRef); continue; }
    const decision = selected[0], audit = records[0];
    const click = related.find(item => item.id === audit.clickActionId);
    const visibility = related.find(item => item.id === audit.visibilityActionId);
    const spec = inspectNativeDynamicLinkClick(click?.function);
    const fields = (dsl?.form?.fields || []).filter(field => field.id === spec?.buttonId);
    const urls = (dsl?.form?.fields || []).filter(field => field.id === spec?.urlFieldId);
    if (!spec || !visibility || fields.length !== 1 || urls.length !== 1 ||
        actions.filter(item => !related.includes(item)).some(item => touchesPrivateFormState(item.function)) ||
        dsl.migrationPolicies?.scope?.baseUrl !== "https://oaqas.shanghai-electric.com" ||
        decision.actionId !== visibility.id || audit.sourceJavascriptSha256 !== decision.sourceJavascriptSha256 ||
        decision.fieldId !== spec.buttonId || decision.sourceUrlFieldId !== spec.urlFieldId ||
        click.scope !== "control" || click.event !== "onClick" || click.controlId !== spec.buttonId || click.runWhen !== undefined ||
        visibility.scope !== "global" || visibility.event !== "onLoad" || visibility.function !== nativeDynamicLinkVisibility(spec) ||
        canonicalJson(click.sourceRefs) !== canonicalJson([sourceRef]) || canonicalJson(visibility.sourceRefs) !== canonicalJson([sourceRef]) ||
        canonicalJson(click.semanticHints?.approvedNativeDynamicLink) !== canonicalJson(spec) ||
        canonicalJson(visibility.semanticHints?.approvedNativeDynamicLink) !== canonicalJson(spec) ||
        fields[0].type !== "button" || fields[0].componentId !== "xform-button" || fields[0].sourceRef !== sourceRef ||
        fields[0].sourceProps?.dynamicHyperlinkProjection?.sourceUrlFieldId !== spec.urlFieldId ||
        fields[0].sourceProps?.dynamicHyperlinkProjection?.urlPolicy !== "source-as-is" ||
        (fields[0].sourceProps?.dynamicHyperlinkProjection?.anchorTarget || "_self") !== spec.target ||
        urls[0].type !== "text" || !["xform-hidden", "xform-input"].includes(urls[0].componentId) || urls[0].props?.multiple === true ||
        urls[0].sourceProps?.mainStringValueBindingFact?.metadata?.count !== 1 ||
        urls[0].sourceProps?.mainStringValueBindingFact?.metadata?.type !== "String" ||
        audit.sourceBindingStatus !== urls[0].sourceProps?.mainStringValueBindingFact?.status ||
        canonicalJson(audit.sourceBindingReasons) !== canonicalJson(urls[0].sourceProps?.mainStringValueBindingFact?.reasons || []) ||
        !hasVerifiedDeterministicScriptBranchProof(click) || !hasVerifiedDeterministicScriptBranchProof(visibility)) fail(sourceRef);
  }
  return diagnostics;
}

function touchesPrivateFormState(source) {
  if (typeof source !== 'string' || !source.trim()) return false;
  let unsafe = false;
  function walk(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Literal' && node.value === '__mkDynamicLinkSnapshotV1') unsafe = true;
    if (node.type === 'MemberExpression' && node.object?.name === 'MKXFORM' &&
        (node.computed ? node.property?.type !== 'Literal' || node.property.value === '$$FORM' : node.property?.name === '$$FORM')) unsafe = true;
    if (node.type === 'Identifier' && ['window', 'globalThis', 'self', 'top', 'parent', 'frames', 'Object', 'Reflect'].includes(node.name) &&
        !(parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) &&
        !(parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand)) unsafe = true;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, node));
      else if (value && typeof value === 'object') walk(value, node);
    }
  }
  try { walk(parse(source, {ecmaVersion:'latest'})); } catch { return true; }
  return unsafe;
}
