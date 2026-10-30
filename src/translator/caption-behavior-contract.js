import { parse } from "acorn";
import { inspectDeterministicScriptBranchProof } from "../dsl/deterministic-script-translations.js";
import { buildFormRuleRefIndex, resolveEffectTarget } from "../dsl/form-rules.js";
import { captionScriptScope } from "./caption-script-scope.js";
import { captionScriptReferences } from "./caption-script-references.js";
import { auditedCaptionOrphans, captionRowRegion } from "./caption-row-scope.js";
import { captionImpactReach } from "./caption-impact-reach.js";
import { captionToastValueProof } from "./caption-toast-value.js";
import { captionNeededCoveredHelpers } from "./caption-covered-helpers.js";
import { captionJsonImpact } from "./caption-json-impact.js";
import { captionHelperUnits } from "./caption-helper-unit.js";
import { abstractRadioScans } from "./caption-radio-scan-boundary.js";

// Reuse the migration path's existing complete row translations. This is a
// semantic coverage contract, not another whole-program JavaScript evaluator.
const VALUE_APIS = new Set(["getValue", "setValue", "getFieldAttr", "setFieldAttr", "getDetailFieldAttr", "setDetailFieldAttr",
  "toast", "updateControl", "setDetailFieldItemAttr", "setProps", "setDetailValues"]);
// These rejections already explain an unsafe binding, domain, or value. A later
// node reach must not reopen the other titles. Unrecognized calls stay eligible
// for a closed local boundary.
const CLOSED_PROOF_REASONS = new Set([
  "attachment_domain_unproven", "currency_conversion_arguments_unproven", "detail_output_domain_unproven",
  "detail_read_arguments_unproven", "detail_read_dependency_unproven", "detail_read_domain_unproven",
  "dropdown_domain_mutated", "dynamic_target_identity", "event_target_region_unproven", "lexical_binding_unproven",
  "nested_assignment_unproven", "nonlocal_binding_write", "poll_callback_binding_unproven", "record_key_unproven",
  "record_value_unproven", "row_region_unproven", "script_binding_ambiguous", "script_binding_unproven",
  "script_callee_shadowed", "script_delete", "script_parameter_unproven", "shared_scalar_escape",
  "unbound_source_function", "unbounded_field_call", "unproven_binding_value", "unproven_callback",
  "unproven_closure_capture", "unproven_condition", "unproven_data_loop", "unproven_data_method",
  "unproven_data_value", "unproven_mutation", "unproven_operator"
]);

export function captionBehaviorContract(source, form, mappedScripts) {
  const auditedOrphans = auditedCaptionOrphans(source);
  const originals = [...(source.form?.controls || []), ...(source.form?.dataFields || []),
    ...(source.form?.detailTables || []).flatMap(table => [table, ...(table.columns || [])])];
  const ranges = new Map(), regions = [], protectedTargets = new Set();
  const index = buildFormRuleRefIndex(form);
  const detailRef = node => {
    const match = typeof node?.value === "string" && /^\$\{table:([A-Za-z_][\w.-]*)\}(?:\.([A-Za-z_][\w.-]*))?$/.exec(node.value);
    if (!match || node.type !== "Literal") return undefined;
    const tables = (form.fields || []).filter(field => field.id === match[1] && field.type === "detailTable");
    if (tables.length !== 1) return undefined;
    if (!match[2]) return { tableId: match[1] };
    const columns = (tables[0].columns || []).filter(field => field.id === match[2]);
    return columns.length === 1 ? { tableId: match[1], columnId: match[2] } : undefined;
  };
  for (const action of mappedScripts?.actions || []) {
    const proof = inspectDeterministicScriptBranchProof(action);
    if (!proof.ok ||
        action.translationStatus !== "mapped" || action.coverage?.status !== "translated" || action.coverage.residuals?.length) continue;
    // An operation on a whole source row remains an operation on that region
    // after its caption and editor become one native wrapper. A field-only
    // visibility operation must keep its separate title.
    let tree;
    try { tree = parse(action.function, { ecmaVersion: "latest" }); } catch { continue; }
    let toastValue;
    const closedMessage = node => {
      if (node?.type === "Literal" && typeof node.value === "string") return true;
      toastValue ||= captionToastValueProof(action.function, tree);
      return Boolean(node && toastValue(node));
    };
    let bounded = true;
    const actionRegions = [], actionTargets = [];
    walk(tree, node => {
      if (node.type === "Identifier" && ["document", "window", "globalThis", "eval", "Function", "$", "jQuery"].includes(node.name)) bounded = false;
      const callee = node.type === "CallExpression" && node.callee;
      const namespace = callee?.type === "MemberExpression" && callee.object;
      if (namespace?.type === "MemberExpression" && namespace.object?.name === "MKXFORM" &&
          (namespace.property.name || namespace.property.value) === "message") {
        if (namespace.computed || namespace.optional || callee.computed || callee.optional || node.optional ||
            callee.property.name !== "error" || node.arguments.length !== 1 || !closedMessage(node.arguments[0])) bounded = false;
        return;
      }
      if (node.type !== "CallExpression" || node.callee?.type !== "MemberExpression" ||
          node.callee.object?.name !== "MKXFORM") return;
      const method = node.callee.property?.name;
      if (node.callee.computed || !VALUE_APIS.has(method)) { bounded = false; return; }
      if (method === "toast") {
        if (node.arguments.length !== 1 || !closedMessage(toastContent(node.arguments[0]))) bounded = false;
        return;
      }
      if (method === "setProps") {
        const id = node.arguments[0]?.type === "Literal" && node.arguments[0].value;
        const properties = node.arguments[1]?.type === "ObjectExpression" && node.arguments[1].properties;
        const field = (form.fields || []).filter(field => field.id === id && field.componentId === "xform-select");
        if (node.arguments.length !== 2 || field.length !== 1 || properties?.length !== 1 ||
            properties[0].type !== "Property" || properties[0].kind !== "init" || properties[0].computed ||
            properties[0].method || properties[0].shorthand ||
            (properties[0].key.name || properties[0].key.value) !== "options") bounded = false;
        return; // Options change editor data, not the native caption wrapper.
      }
      if (method === "setDetailValues") {
        const table = detailRef(node.arguments[0]);
        if (node.arguments.length !== 2 || !table || table.columnId) bounded = false;
        else actionTargets.push(table.tableId, ...(form.fields.find(field => field.id === table.tableId).columns || []).map(field => field.id));
        return; // Replacement protects the entire existing table presentation.
      }
      if (method === "updateControl") {
        if (node.arguments.length !== 3 || !detailRef(node.arguments[0])?.columnId) bounded = false;
        return; // Native updateControl writes a proven detail value, not its title.
      }
      if (method === "setDetailFieldItemAttr") {
        const table = detailRef(node.arguments[0]), field = detailRef(node.arguments[3]);
        if (![3, 4].includes(node.arguments.length) || !table || table.columnId ||
            node.arguments.length === 4 && (!field?.columnId || field.tableId !== table.tableId)) { bounded = false; return; }
        actionTargets.push(table.tableId, ...(field ? [field.columnId] : []));
        return;
      }
      if (method !== "setFieldAttr") return;
      const id = node.arguments[0]?.type === "Literal" && node.arguments[0].value;
      const resolved = typeof id === "string" && resolveEffectTarget(index, id);
      if (!resolved || resolved.unresolved?.length) { bounded = false; return; }
      if (resolved.source === "rowMarker") actionRegions.push(id);
      else if (!(node.arguments[1]?.type === "Literal" && [1, 2, 3, 6].includes(node.arguments[1].value))) actionTargets.push(id);
    });
    if (!bounded) continue;
    const covered = action.semanticHints?.coveredCalculationRanges || [];
    if (!covered.length) continue;
    for (const range of covered) {
      if (!ranges.has(range.sourceRef)) ranges.set(range.sourceRef, []);
      ranges.get(range.sourceRef).push(range);
    }
    actionTargets.forEach(id => protectedTargets.add(id));
    regions.push(...actionRegions.map(target => ({ actionId: action.id, target,
      targets: resolveEffectTarget(index, target).targets.map(item => item.id), basis: action.deterministicBranchProof.basis })));
  }
  const programs = new Map();
  const add = (text, sourceRef) => {
    if (typeof text !== "string" || !text.trim()) return;
    const key = text.trim();
    const entry = programs.get(key) || { text, sourceRefs: new Set() };
    if (sourceRef) entry.sourceRefs.add(sourceRef);
    programs.set(key, entry);
  };
  for (const item of source.scripts?.sources || []) { add(item.javascript, item.sourceRef); add(item.helperJavascript); }
  for (const field of originals) {
    for (const [key, value] of Object.entries(field.sourceProps?.designerValues || {})) {
      if (/^(?:on|script|function|event)/i.test(key)) add(value);
    }
    const context = field.sourceProps?.captionStructure?.domContext || field.sourceProps?.staticCaptionFact?.domContext;
    for (const script of context?.inlineScripts || []) add(script);
  }
  const consumed = [], statements = new Map();
  const statementKey = node => JSON.stringify(node, (key, value) => ["start", "end", "raw"].includes(key) ? undefined : value);
  // Runtime exports can combine the same statements into a larger SCRIPT or
  // add whitespace. Match whole AST statements, never a textual substring.
  for (const program of programs.values()) {
    const covered = [...program.sourceRefs].flatMap(ref => ranges.get(ref) || []);
    if (!covered.length) continue;
    let ast;
    try { ast = parse(program.text, { ecmaVersion: "latest", allowReturnOutsideFunction: true }); } catch { continue; }
    for (const node of ast.body) if (covered.some(range => {
      const expression = node.type === "ExpressionStatement" ? node.expression : node;
      return (
      Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 &&
      range.end <= program.text.length && range.start <= expression.start && range.end >= expression.end);
    })) {
      statements.set(statementKey(node), [...program.sourceRefs]);
    }
  }
  const neededHelpers = captionNeededCoveredHelpers([...programs.values()], statements, statementKey);
  const residuals = [...programs.values()].map(program => {
    if (!statements.size) return program.text;
    let ast;
    try { ast = parse(program.text, { ecmaVersion: "latest", allowReturnOutsideFunction: true }); } catch { return program.text; }
    // Direct Program declarations are instantiated together: an earlier body
    // cannot be observed before the final same-name declaration in that Program.
    // Only a fully covered final declaration grants this proof. Never carry it
    // across SCRIPT boundaries or infer a winner for block/unknown declarations.
    const lastDeclarations = new Map(ast.body.filter(node => node.type === "FunctionDeclaration")
      .map(node => [node.id?.name, node]));
    const shadowed = node => node.type === "FunctionDeclaration" && lastDeclarations.get(node.id?.name) !== node &&
      statements.has(statementKey(lastDeclarations.get(node.id?.name)));
    const removed = ast.body.filter(node => statements.has(statementKey(node)) &&
      !(node.type === "FunctionDeclaration" && neededHelpers.has(node.id?.name)) || shadowed(node));
    let text = program.text;
    for (const node of removed.reverse()) {
      consumed.push({ sourceRefs: statements.get(statementKey(shadowed(node) ? lastDeclarations.get(node.id.name) : node)),
        start: node.start, end: node.end,
        ...(shadowed(node) ? { basis: "covered-same-program-hoisted-declaration", shadowedByStart: lastDeclarations.get(node.id.name).start } : {}) });
      text = text.slice(0, node.start) + text.slice(node.start, node.end).replace(/[^\r\n]/g, " ") + text.slice(node.end);
    }
    return text;
  });
  const sourcePrograms = [...programs.values()].map(program => program.text);
  const jsonImpact = captionJsonImpact(source, form, residuals);
  const helperUnits = captionHelperUnits(source, mappedScripts);
  let scope = captionScriptReferences(residuals).opaque
    ? captionScriptScope(residuals, form, originals, { auditedOrphans, sharedScalarPrograms: sourcePrograms, jsonImpact, helperUnits }) : { ok: true, targets: [], parentReads: [] };
  let proofMode = "mapped-statements-and-residual-impact";
  if (!scope.ok) {
    // A partially mapped helper may still be called by an unmapped action.
    // Keep the existing complete-program proof as a compatibility fallback;
    // do not turn a removed declaration into evidence of an unknown effect.
    const texts = [...programs.values()].map(program => program.text);
    const complete = captionScriptReferences(texts).opaque
      ? captionScriptScope(texts, form, originals, { auditedOrphans, helperUnits }) : { ok: true, targets: [], parentReads: [] };
    if (complete.ok) { scope = complete; proofMode = "complete-original-impact"; }
  }
  const residualPrograms = [...new Set(residuals.filter(Boolean))];
  const issue = scope.issue && { ...scope.issue,
    sourceSnippet: residualPrograms[scope.issue.scriptIndex]?.slice(Math.max(0, (scope.issue.offset || 0) - 60), (scope.issue.offset || 0) + 140) };
  let boundary;
  if (!scope.ok) {
    // The interpreter stops at the first unrecognized statement. Its reach is a
    // separate question: a closed set of nodes does not block every other pair.
    boundary = captionImpactReach(residualPrograms);
    if (boundary.bounded) {
      const anchors = new Set(boundary.anchors);
      for (const marker of boundary.rowMarkers || []) {
        const region = captionRowRegion(form, index, marker);
        if (!region?.targets?.length) { boundary = { ...boundary, bounded: false, reason: "row_region_unproven", marker }; break; }
        region.targets.forEach(target => anchors.add(target.id));
      }
      if (boundary.bounded && !CLOSED_PROOF_REASONS.has(issue?.reason) &&
          (anchors.size || boundary.selectors?.length || boundary.rowMarkers?.length)) {
        // A bounded analysis that names no node, selector or row does not explain
        // why the stricter contract rejected the program. Leave that rejection
        // closed for the whole form.
        scope = { ok: true, targets: [...anchors], presentationTargets: [...anchors], dataTargets: [], parentReads: [],
          rowRegions: [], localBoundary: { ...boundary, anchors: [...anchors] } };
        proofMode = "local-script-boundary";
      }
    }
  }
  return {
    summary: { coveredSourceStatements: consumed, regionMappings: regions, residualScope: { ...scope, issue },
      ...(neededHelpers.size ? { retainedCoveredHelpers: [...neededHelpers] } : {}) },
    forPair(fieldId, captionId, context) {
      let pairScope = scope, pairProofMode = proofMode, radioScanEvidence;
      if (!pairScope.ok && context?.radioFree === true && context.inlineDomainComplete === true) {
        const abstracted = abstractRadioScans(residualPrograms, form);
        const fullSource = abstractRadioScans(sourcePrograms, form);
        if (abstracted && fullSource) {
          const impact = captionJsonImpact(source, form, abstracted.programs);
          const candidate = captionScriptReferences(abstracted.programs).opaque
            ? captionScriptScope(abstracted.programs, form, originals, { auditedOrphans,
              sharedScalarPrograms: fullSource.programs, jsonImpact: impact, helperUnits })
            : { ok: true, targets: [], parentReads: [] };
          if (candidate.ok) { pairScope = candidate; pairProofMode = "pair-radio-scan-boundary";
            radioScanEvidence = { residual: abstracted.evidence, fullSource: fullSource.evidence }; }
        }
      }
      if (!pairScope.ok) return { ok: false, bounded: false, issue: { ...issue, impact: "unbounded-form",
        boundary: boundary?.reason, boundaryOffset: boundary?.offset, boundaryDetails: boundary?.details, residualPrograms: residuals.length } };
      const ids = [fieldId, captionId, ...(context?.ancestorIds || []), ...(context?.pairDescendantIds || [])];
      const presentation = pairScope.presentationTargets || pairScope.targets;
      const splitRegion = [...regions, ...(pairScope.rowRegions || [])].find(region =>
        region.targets.includes(fieldId) !== region.targets.includes(captionId));
      if (splitRegion) return { ok: false, bounded: true, issue: { reason: "row_region_separates_title_and_value",
        impact: "fixed-source-region", region: splitRegion } };
      if (ids.some(id => protectedTargets.has(id) || presentation.includes(id)) ||
          pairScope.parentReads?.some(id => context?.cellDescendantIds?.includes(id))) {
        return { ok: false, bounded: true, issue: { reason: pairScope.localBoundary ? "local_script_reach" : "independent_presentation_effect",
          impact: "fixed-source-region", ...(pairScope.localBoundary ? { boundary: pairScope.localBoundary } : {}),
          targets: [...new Set([...protectedTargets, ...presentation])], dataTargets: pairScope.dataTargets || [], parentReads: pairScope.parentReads } };
      }
      if ((residuals.some(text => text.trim()) || regions.length) && context?.version !== 1) {
        return { ok: false, bounded: false, issue: { reason: "script_region_unproven", impact: "unknown-ancestors" } };
      }
      return { ok: true, evidence: { version: 1, proofMode: pairProofMode, regionMappings: regions, coveredSourceStatements: consumed,
        ...(radioScanEvidence ? { radioScanEvidence } : {}),
        ...(neededHelpers.size ? { retainedCoveredHelpers: [...neededHelpers] } : {}),
        residualImpact: { presentationTargets: presentation, dataTargets: pairScope.dataTargets || [],
          ...(pairScope.inertSubmitScratch?.length ? { inertSubmitScratch: pairScope.inertSubmitScratch } : {}),
          ...(pairScope.inertRowNoops?.length ? { inertRowNoops: pairScope.inertRowNoops } : {}),
          ...(pairScope.nativeCurrencyBindings?.length ? { nativeCurrencyBindings: pairScope.nativeCurrencyBindings } : {}),
          ...(pairScope.attachmentBindings?.length ? { attachmentBindings: pairScope.attachmentBindings } : {}),
          ...(pairScope.sharedScalars?.length ? { sharedScalars: pairScope.sharedScalars } : {}),
          ...(pairScope.sourceValueReads?.length ? { sourceValueReads: pairScope.sourceValueReads } : {}),
          ...(pairScope.dataLoops?.length ? { dataLoops: pairScope.dataLoops } : {}),
          ...(pairScope.tablePollEffects?.length ? { tablePollEffects: pairScope.tablePollEffects } : {}),
          ...(pairScope.detailDataReads?.length ? { detailDataReads: pairScope.detailDataReads } : {}),
          ...(pairScope.sharedJsonData ? { sharedJsonData: pairScope.sharedJsonData } : {}),
          ...(pairScope.nonEntryHelpers?.length ? { nonEntryHelpers: pairScope.nonEntryHelpers } : {}),
          ...(pairScope.outsideExportIds?.length ? { outsideExportIds: pairScope.outsideExportIds } : {}),
          ...(pairScope.localBoundary ? { localBoundary: { anchors: pairScope.localBoundary.anchors, selectors: pairScope.localBoundary.selectors,
            rowMarkers: pairScope.localBoundary.rowMarkers } } : {}),
          rowRegions: pairScope.rowRegions || [], parentReads: pairScope.parentReads || [] } } };
    }
  };
}

function toastContent(node) {
  if (node?.type !== "ObjectExpression") return node;
  const properties = node.properties;
  if (properties.length !== 2 || properties.some(property => property.type !== "Property" ||
      property.kind !== "init" || property.computed || property.method || property.shorthand)) return undefined;
  const content = properties.find(property => (property.key.name || property.key.value) === "content");
  const icon = properties.find(property => (property.key.name || property.key.value) === "icon");
  return content && icon?.value.type === "Literal" && icon.value.value === "fail" ? content.value : undefined;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(item => walk(item, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}
