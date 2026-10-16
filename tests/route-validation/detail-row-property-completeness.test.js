import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { parse } from "acorn";
import { it } from "node:test";
import { runRouteCase } from "./run-route-case.js";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapStringPuts, attrValue, decodeEntities } from "../../src/translator/xml-utils.js";
import { scanHtmlTags } from "../../src/translator/designer-html-tokenizer.js";
import { isCompleteDetailControlDisplay } from "../../src/translator/detail-row-control-state.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";

const dir = "tests/fixtures/route-validation/detail-row-property-completeness";
const paths = name => `${dir}/${name}_SysFormTemplate.xml`;
const xml = readFileSync(paths("row-property"), "utf8");
const plainXml = readFileSync(paths("row-state-only"), "utf8");
const legacy = JSON.parse(readFileSync(`${dir}/unsafe-legacy-detail-actions.json`));
const stages = file => { const source = cleanSourceFile(file); return { source, draft: draftSourceDraft(source) }; };
const stateAction = draft => draft.scripts.actions.find(a => a.event === "onChange" && a.controlId === "fd_choice");
const loadAction = draft => draft.scripts.actions.find(a => a.event === "onLoad");
const sourceJs = source => source.scripts.sources[0].javascript;
function helper(text) {
  const node = parse(text, { ecmaVersion: "latest" }).body.find(n => n.type === "FunctionDeclaration" && n.id.name === "controlDisplay");
  assert.ok(node, "Synthetic source helper must exist");
  return text.slice(node.start, node.end);
}
function rewrite(properties, transform) {
  const token = [...scanHtmlTags(properties.fdDesignerHtml)].find(t => !t.closing && t.name === "input" && attrValue(t.attrs, "value").includes("&lt;script&gt;"));
  assert.ok(token, "Synthetic JSP input must be present");
  const script = transform(decodeEntities(attrValue(token.attrs, "value")));
  const attribute = script.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  properties.fdDesignerHtml = properties.fdDesignerHtml.slice(0, token.start) + `<input type="hidden" value="${attribute}"/>` + properties.fdDesignerHtml.slice(token.end);
}
function variant(transform, original = xml) {
  const properties = parseRootHashMapStringPuts(original), folder = mkdtempSync(join(tmpdir(), "detail-properties-"));
  const esc = s => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    rewrite(properties, transform);
    const file = join(folder, "variant_SysFormTemplate.xml");
    writeFileSync(file, '<java><object class="java.util.HashMap">' + Object.entries(properties).map(([k, v]) => `<void method="put"><string>${k}</string><string>${esc(v)}</string></void>`).join("") + "</object></java>");
    return stages(file);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}
function assertUnclosed(action) {
  assert.ok(action, "The source action must remain present");
  assert.equal(action.translationStatus, "needs_review");
  assert.ok(action.coverage.residuals.length > 0, "Unsupported source behavior must retain residual evidence");
  assert.notEqual(action.coverage.status, "translated");
}
const placeholderLine = '  document.getElementsByName("extendDataFormInfo.value(fd_detail."+i+".fd_notes)")[0].setAttribute("placeholder","replacement details");';

it("retains the complete same-row hidden/display/validate helper", () => {
  const { source, draft } = stages(paths("row-state-only"));
  assert.equal(isCompleteDetailControlDisplay(helper(sourceJs(source))), true);
  const action = stateAction(draft);
  assert.equal(action.translationStatus, "mapped");
  assert.equal(action.coverage.status, "translated");
  assert.deepEqual(action.coverage.residuals, []);
});
it("does not call a helper complete after ignoring its conditional row placeholder", () => {
  const { source } = stages(paths("row-property"));
  assert.equal(isCompleteDetailControlDisplay(helper(sourceJs(source))), false);
});
for (const [name, line] of [
  ["unknown row attribute", placeholderLine.replace('"placeholder"', '"aria-label"')],
  ["direct placeholder property", '  document.getElementsByName("extendDataFormInfo.value(fd_detail."+i+".fd_notes)")[0].placeholder="replacement details";'],
  ["another property assignment", '  document.getElementsByName("extendDataFormInfo.value(fd_detail."+i+".fd_notes)")[0].readOnly=true;'],
  ["unknown side effect", "  unmodeledSideEffect(i);"],
  ["dynamic placeholder text", placeholderLine.replace('"replacement details"', 'String(value)')]
]) it("rejects whole-helper completeness for " + name, () => {
  const { source } = variant(js => js.replace(placeholderLine, line));
  assert.equal(isCompleteDetailControlDisplay(helper(sourceJs(source))), false);
});
it("does not count comment-only markers as executable effects", () => {
  assert.equal(isCompleteDetailControlDisplay('function controlDisplay(value,i){ /* hidden.value="true"; target.style.display=""; target.setAttribute("validate","required"); */ }'), false);
});
it("keeps the source conditional property and static source placeholder distinct", () => {
  const { source, draft } = stages(paths("row-property"));
  assert.ok(sourceJs(source).includes(placeholderLine));
  const notes = draft.form.fields.find(f => f.id === "fd_detail").columns.find(f => f.id === "fd_notes");
  assert.equal(notes.componentId, "xform-textarea");
  assert.equal(notes.props.placeholder, "replacement asset number");
  assertUnclosed(stateAction(draft));
});
it("keeps the complete first-row conditional load source unclosed", () => {
  const { source, draft } = stages(paths("row-property"));
  assert.ok(sourceJs(source).includes('if(enabled=="sb" && rows.length>0)'));
  assert.ok(sourceJs(source).includes('value(fd_detail.0.fd_notes)'));
  assertUnclosed(loadAction(draft));
});
it("does not replace wiring-only window.load with an invented row initializer", () => {
  assertUnclosed(loadAction(stages(paths("row-state-only")).draft));
});
it("retains a window.load side effect rather than swallowing the entire listener", () => {
  const { draft } = variant(js => js.replace('function(){wireRows();}', 'function(){wireRows();unmodeledStartup();}'), plainXml);
  assertUnclosed(loadAction(draft));
});
it("retains row placeholder residuals when native rules cover only the main field row toggle", () => {
  const { source, draft } = stages(paths("main-row-property"));
  assert.ok(sourceJs(source).includes('value(fd_detail.0.fd_notes)'));
  assert.equal(draft.formRules.linkage.length, 1, "The proven native visibility/required linkage must remain");
  assertUnclosed(draft.scripts.actions[0]);
});
it("keeps unconditional main placeholder-only static coverage", () => {
  const { draft } = stages(paths("main-static-placeholder"));
  assert.deepEqual(draft.scripts.actions[0].coverage, {
    status: "covered", nativeRules: [], staticProps: [{ fieldId: "fd_main_notes", prop: "placeholder", value: "main hint" }], residuals: []
  });
});
it("does not promote a main placeholder-only initializer with another side effect", () => {
  const original = readFileSync(paths("main-static-placeholder"), "utf8");
  const { draft } = variant(js => js.replace('field.setAttribute("placeholder","main hint");', 'field.setAttribute("placeholder","main hint");field.value="changed";'), original);
  assert.equal(draft.scripts.actions[0].coverage.staticProps, undefined);
});
function sourceDom(source) {
  const nodes = new Map(), listeners = [];
  for (let row = 0; row < 2; row++) for (const field of ["fd_choice", "fd_notes", "fd_hidden"]) {
    const node = { value: field === "fd_choice" ? "xg" : "", style: { display: "none" }, attributes: { placeholder: "replacement asset number", validate: "" }, setAttribute(key, value) { this.attributes[key] = value; } };
    nodes.set(`extendDataFormInfo.value(fd_detail.${row}.${field})`, node);
  }
  const category = { value: "other" }, rowModels = [{}, {}], window = {};
  const context = vm.createContext({ window, document: { getElementsByName(name) { assert.ok(nodes.has(name), "Only declared synthetic row lookups are modeled"); return [nodes.get(name)]; } }, GetXFormFieldById(id) { if (id === "fd_main") return [category]; if (id === "fd_detail") return rowModels; throw new Error("Unmodeled source lookup"); }, Com_AddEventListener(target, event, callback) { assert.equal(target, window); assert.equal(event, "load"); listeners.push(callback); } });
  vm.runInContext(sourceJs(source), context, { timeout: 100 });
  return { context, nodes, category, listeners, node(row, field) { return nodes.get(`extendDataFormInfo.value(fd_detail.${row}.${field})`); } };
}
it("source gh→xg→gh preserves its no-reset property history and row isolation", () => {
  const model = sourceDom(stages(paths("row-property")).source);
  model.context.controlDisplay("gh", 0);
  assert.equal(model.node(0, "fd_notes").attributes.placeholder, "replacement details");
  model.context.controlDisplay("xg", 0);
  assert.equal(model.node(0, "fd_notes").style.display, "none");
  assert.equal(model.node(0, "fd_notes").attributes.placeholder, "replacement details", "Source else does not reset the text");
  assert.equal(model.node(1, "fd_notes").attributes.placeholder, "replacement asset number");
  model.context.controlDisplay("gh", 0);
  assert.equal(model.node(0, "fd_notes").attributes.validate, "required");
});
it("source load writes only row0 after both outer and hidden-state conditions", () => {
  const model = sourceDom(stages(paths("row-property")).source);
  model.node(0, "fd_hidden").value = "true";
  model.listeners[0]();
  assert.equal(model.node(0, "fd_notes").attributes.placeholder, "replacement asset number", "Outside the category branch source does not assign");
  model.category.value = "sb";
  model.listeners[0]();
  assert.equal(model.node(0, "fd_notes").attributes.placeholder, "replacement details");
  assert.equal(model.node(1, "fd_notes").attributes.placeholder, "replacement asset number");
});
it("source load does not use a gh trigger as a substitute for hidden state", () => {
  const model = sourceDom(stages(paths("row-property")).source);
  model.category.value = "sb"; model.node(0, "fd_choice").value = "gh";
  model.listeners[0]();
  assert.equal(model.node(0, "fd_notes").style.display, "none");
  assert.equal(model.node(0, "fd_notes").attributes.placeholder, "replacement asset number");
});
function trusted(source, draft) { return createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "synthetic incomplete-row-property negative" }); }
it("public trust refuses the unchanged incomplete source recipe despite external-reviewed metadata", () => {
  const { source, draft } = stages(paths("row-property"));
  assert.equal(checkTrust(source, trusted(source, draft)).ok, false);
});
it("public trust refuses the retained historical mapped functions and false empty residuals", () => {
  const { source, draft } = stages(paths("row-property")), changed = structuredClone(draft);
  for (const old of legacy.actions) {
    const index = changed.scripts.actions.findIndex(a => a.id === old.id);
    assert.ok(index >= 0); changed.scripts.actions[index] = structuredClone(old);
  }
  assert.equal(checkTrust(source, trusted(source, changed)).ok, false);
});
it("public apply refuses source-bound old three-effect mappings as full property closure", () => {
  const { source, draft } = stages(paths("row-property"));
  const patches = legacy.actions.flatMap(old => {
    const index = draft.scripts.actions.findIndex(a => a.id === old.id);
    assert.ok(index >= 0);
    return ["function", "translationStatus", "coverage", "functionMappings"].map(key => ({
      op: "replace", path: `/scripts/actions/${index}/${key}`, value: old[key], sourceRefs: old.sourceRefs,
      evidence: ["Synthetic source contains an extra conditional same-row property write; this historical native function omits it."],
      confidence: 0.99, rationale: "Negative source-fidelity fixture; correct source identity is insufficient to erase uncovered effects."
    }));
  });
  const result = applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source), normalizeSourceRefs: true });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.every(d => !["agent.patch.evidence_required", "agent.patch.confidence_invalid"].includes(d.code)));
});
it("public trust refuses native-rule omission that loses the main event's row property", () => {
  const { source, draft } = stages(paths("main-row-property"));
  assert.equal(checkTrust(source, trusted(source, draft)).ok, false);
});

const gateCode = "trust.script.detail_row_source_effect_unproven";
const stateIndex = draft => draft.scripts.actions.indexOf(stateAction(draft));
function withClosedAction(draft, index, mutate = () => {}) {
  const changed = structuredClone(draft), action = changed.scripts.actions[index];
  action.translationStatus = "omitted";
  action.function = "";
  action.coverage = { status: "covered", nativeRules: [], residuals: [] };
  delete action.deterministicBranchProof;
  mutate(action, changed);
  return changed;
}
function assertSourceGate(source, draft, actionId) {
  const check = checkTrust(source, trusted(source, draft));
  assert.equal(check.ok, false);
  assert.ok(check.diagnostics.some(d => d.code === gateCode && d.details?.actionId === actionId),
    "The specific source effect gate must reject this action; another pending action is insufficient evidence");
}
it("identifies helper source completeness independently of the separate pending load", () => {
  const { source, draft } = stages(paths("row-property"));
  assert.equal(draft.scripts.actions.length, 2);
  assert.equal(stateAction(draft).event, "onChange");
  assert.equal(loadAction(draft).translationStatus, "needs_review");
  assertSourceGate(source, withClosedAction(draft, stateIndex(draft)), stateAction(draft).id);
});
it("isolates main native linkage property completeness from any helper or load", () => {
  const { source, draft } = stages(paths("main-row-property"));
  assert.equal(draft.scripts.actions.length, 1);
  assertSourceGate(source, withClosedAction(draft, 0), draft.scripts.actions[0].id);
});
it("isolates lifecycle completeness while the plain three-effect helper remains mapped", () => {
  const { source, draft } = stages(paths("row-state-only"));
  assert.equal(stateAction(draft).translationStatus, "mapped");
  const index = draft.scripts.actions.findIndex(a => a.event === "onLoad");
  assertSourceGate(source, withClosedAction(draft, index), draft.scripts.actions[index].id);
});
for (const basis of ["semantic-translation", "native-form-rule", "static-form-prop", "renamed-review-metadata"]) {
  it("does not launder unsupported source effects through " + basis, () => {
    const { source, draft } = stages(paths("row-property"));
    const changed = withClosedAction(draft, stateIndex(draft), action => {
      action.functionMappings = [{ source: "reviewer claim", target: "unproven closure", basis, reviewRequired: false }];
      delete action.recipe; delete action.semanticHints; delete action.branchProvenance;
    });
    assertSourceGate(source, changed, stateAction(draft).id);
  });
}
for (const [name, mutate] of [
  ["removed residual", action => action.coverage.residuals = []],
  ["changed residual evidence", action => action.coverage.residuals[0].evidence = "changed"],
  ["changed residual code", action => action.coverage.residuals[0].code = "reviewer-renamed-residual"],
  ["deleted action", (_action, draft) => draft.scripts.actions = []],
  ["deleted scripts", (_action, draft) => delete draft.scripts],
  ["changed action ID", action => action.id += "-renamed"],
  ["changed source refs", action => action.sourceRefs = ["source.not-the-owner"]],
  ["changed event", action => action.event = "onLoad"],
  ["changed scope", action => action.scope = "global"],
  ["changed table owner", action => action.tableId = "fd_other"],
  ["changed control owner", action => action.controlId = "fd_other"]
]) it("retains source ownership and residuals despite " + name, () => {
  const { source, draft } = stages(paths("row-property")), changed = structuredClone(draft);
  mutate(stateAction(changed), changed);
  assertSourceGate(source, changed, stateAction(draft).id);
});
it("allows review patches that keep the complete protected source residual pending", () => {
  const { source, draft } = stages(paths("row-property"));
  const action = stateAction(draft);
  const result = applyEvidenceBackedPatches(draft, [{ op: "replace", path: `/scripts/actions/${stateIndex(draft)}/coverage`, value: structuredClone(action.coverage), sourceRefs: action.sourceRefs,
    evidence: ["The source effect remains pending; no behavior closure is claimed."], confidence: .99, rationale: "Preserve source residual exactly." }],
  { sourceDraft: source, sourceRefs: collectSourceRefs(source), normalizeSourceRefs: true });
  assert.equal(result.ok, true);
});
it("does not let a mutated input draft wash out source residuals before public apply", () => {
  const { source, draft } = stages(paths("row-property")), changed = withClosedAction(draft, stateIndex(draft));
  const result = applyEvidenceBackedPatches(changed, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.code === "agent.patch.detail_row_source_effect_unproven"));
});
for (const [name, transform] of [
  ["mismatching row index", text => text.replaceAll('"+i+".fd_notes', '"+j+".fd_notes')],
  ["mismatching table", text => text.replace('fd_detail."+i+".fd_notes', 'fd_other."+i+".fd_notes')],
  ["different validation target", text => text.replace('fd_notes)\")[0].setAttribute', 'fd_wrong)\")[0].setAttribute')],
  ["branch value reversed", text => text.replace('hidden.value="true"', 'hidden.value=""')],
  ["hidden and target alias", text => text.replaceAll('fd_hidden', 'fd_notes')],
  ["early return", text => text.replace('if(value=="gh")', 'if(value=="gh")return; if(value=="gh")')]
]) it("does not prove the complete recipe with " + name, () => {
  const { source } = stages(paths("row-state-only"));
  const original = helper(sourceJs(source)), changed = transform(original);
  assert.notEqual(changed, original, "The counterexample must actually alter the helper");
  assert.equal(isCompleteDetailControlDisplay(changed), false);
});

for (const caseId of ["detail-row-property-blocked-before-transport", "main-row-property-blocked-before-transport"]) {
  it("blocks the complete fake review route before transport: " + caseId, async () => {
    const result = await runRouteCase(caseId);
    assert.equal(result.review.stage, "agent-review.incomplete");
    assert.deepEqual(result.transcript, []);
    assert.equal(result.execution, undefined);
    assert.equal(result.dryRun, undefined);
  });
}
it("does not move the unsupported helper residual into a different pending action", () => {
  const { source, draft } = stages(paths("row-property")), changed = structuredClone(draft);
  const original = stateAction(draft), actual = stateAction(changed);
  loadAction(changed).coverage.residuals.push(...actual.coverage.residuals);
  actual.coverage.residuals = [];
  assertSourceGate(source, changed, original.id);
});
it("rejects duplicate pending owners even when both retain the same source residual", () => {
  const { source, draft } = stages(paths("row-property")), changed = structuredClone(draft);
  changed.scripts.actions.push(structuredClone(stateAction(changed)));
  assertSourceGate(source, changed, stateAction(draft).id);
});
it("does not classify a supported ordinary main-field assignment as a row property mutation", () => {
  const original = readFileSync(paths("main-row-property"), "utf8");
  const { draft } = variant(js => js.replace('document.getElementsByName("extendDataFormInfo.value(fd_detail.0.fd_notes)")[0].setAttribute("placeholder","replacement details");',
    'SetXFormFieldValueById("fd_main",value,false);'), original);
  assert.equal(draft.scripts.actions[0].coverage.residuals.some(residual => residual.code === "script.residual.detail_row_property_unproven"), false);
});

it("preserves the exact source comparison literal including leading and trailing spaces", () => {
  const { draft } = variant(js => js.replace('if(value=="gh")', 'if(value==" gh ")'), plainXml);
  const action = stateAction(draft), updates = [];
  assert.equal(action.translationStatus, "mapped");
  assert.equal(action.recipe.matchValue, " gh ");
  const context = vm.createContext({ MKXFORM: { viewStatus: "add", updateControl(...args) { updates.push(args); }, updateControlStyle() {}, setDetailFieldItemAttr() {} } });
  vm.runInContext(action.function, context, { timeout: 100 });
  context.onChange(" gh ", 0);
  assert.equal(updates.at(-1)[2], "true");
  context.onChange("gh", 0);
  assert.equal(updates.at(-1)[2], "");
});
for (const [name, transform] of [
  ["a different row than the wired source field", js => js.replace('controlDisplay(this.value,"+i+"', 'controlDisplay(this.value,"+(i+1)+"')],
  ["a constant instead of the wired field value", js => js.replace('controlDisplay(this.value,', "controlDisplay('xg',")],
  ["another executable statement in the onclick string", js => js.replace('controlDisplay(this.value,"+i+")', 'controlDisplay(this.value,"+i+");unmodeledClick()')]
]) it("retains the candidate pending for a binding with " + name, () => {
  let sourceChanged = false;
  const { draft } = variant(js => { const changed = transform(js); sourceChanged = changed !== js; return changed; }, plainXml);
  assert.equal(sourceChanged, true, "The binding counterexample must be applied");
  const action = stateAction(draft);
  assertUnclosed(action);
  assert.ok(action.coverage.residuals.some(r => r.code === "script.residual.detail_row_effect_unproven"));
});

const rowPropertySource = 'document.getElementsByName("extendDataFormInfo.value(fd_detail.0.fd_notes)")[0]';
function mainAliasVariant(setter) {
  const original = readFileSync(paths("main-row-property"), "utf8");
  return variant(js => js.replace(rowPropertySource + '.setAttribute("placeholder","replacement details");', setter), original);
}
for (const [name, setter] of [
  ["local row element alias", `var rowNote=${rowPropertySource};rowNote.setAttribute("placeholder","replacement details");`],
  ["chained row element alias", `var rowNote=${rowPropertySource};var alias=rowNote;alias.setAttribute("placeholder","replacement details");`],
  ["assigned row element alias", `var rowNote;rowNote=${rowPropertySource};rowNote.setAttribute("placeholder","replacement details");`],
  ["aliased direct property", `var rowNote=${rowPropertySource};rowNote.placeholder="replacement details";`],
  ["dynamic row property", `var rowNote=${rowPropertySource};var propertyName="placeholder";rowNote[propertyName]="replacement details";`],
  ["escaped row element", `var rowNote=${rowPropertySource};unmodeledRowPropertyEffect(rowNote);`]
]) it("does not erase unsupported effects behind a " + name, () => {
  const { source, draft } = mainAliasVariant(setter), action = draft.scripts.actions[0];
  assert.equal(draft.scripts.actions.length, 1);
  assert.equal(draft.formRules.linkage.length, 1);
  assertUnclosed(action);
  assert.ok(action.coverage.residuals.some(r => r.code === "script.residual.detail_row_property_unproven"));
  const changed = withClosedAction(draft, 0, candidate => {
    candidate.coverage.nativeRules = [...action.coverage.nativeRules];
    candidate.functionMappings = [{ source: "source conditions", target: "native linkage", basis: "native-form-rule", reviewRequired: false }];
  });
  assertSourceGate(source, changed, action.id);
  const patches = ["function", "translationStatus", "coverage", "functionMappings"].map(key => ({
    op: "replace", path: `/scripts/actions/0/${key}`, value: changed.scripts.actions[0][key], sourceRefs: action.sourceRefs,
    evidence: ["The source row property remains behind a local alias; native linkage covers only row state."], confidence: .99, rationale: "Source identity does not close omitted property effects."
  }));
  const applied = applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source), normalizeSourceRefs: true });
  assert.equal(applied.ok, false);
  assert.ok(applied.diagnostics.some(d => d.code === "agent.patch.detail_row_source_effect_unproven"));
});
it("does not classify an ordinary main field alias as a detail row property", () => {
  const { draft } = mainAliasVariant('var mainNote=document.getElementsByName("extendDataFormInfo.value(fd_main)")[0];mainNote.setAttribute("placeholder","main hint");');
  assert.equal(draft.scripts.actions[0].coverage.residuals.some(r => r.code === "script.residual.detail_row_property_unproven"), false);
});

it("keeps protected detail-row review guidance pending without an executable patch example", () => {
  const { source, draft } = stages(paths("row-property"));
  const prompt = buildAgentReviewPrompt(source, draft);
  const action = prompt.context.dslDraft.scripts.actions.find(a => a.id === stateAction(draft).id);
  const opportunity = action.reviewOpportunities.find(item => item.kind === "detail_row_visibility_candidate");
  assert.ok(opportunity);
  assert.equal(Object.hasOwn(opportunity, "suggestedPatchShape"), false);
  assert.match(opportunity.safeDecision, /Keep needs_review/);
  assert.match(opportunity.coverageDecision, /every specific detail-row source residual/);
  assert.match(opportunity.eventScaffoldingPolicy, /Only fixed-source proof of complete binding and effects/);
  assert.ok(opportunity.requiredBusinessSemantics.some(text => text.includes("actual source comparison literal exactly")));
  assert.ok(opportunity.requiredBusinessSemantics.every(text => !text.includes("trigger value gh")));
  const load = prompt.context.dslDraft.scripts.actions.find(a => a.id === loadAction(draft).id);
  const lifecycle = load.reviewOpportunities.find(item => item.kind === "detail_row_load_initialization_candidate");
  assert.match(lifecycle.safeDecision, /Keep needs_review and every original source residual/);
});
it("retains existing patch guidance for an opportunity without a protected source residual", () => {
  const { source, draft } = stages(paths("row-property"));
  const example = structuredClone(draft);
  stateAction(example).coverage.residuals = [];
  const prompt = buildAgentReviewPrompt(source, example);
  const action = prompt.context.dslDraft.scripts.actions.find(a => a.id === stateAction(example).id);
  const opportunity = action.reviewOpportunities.find(item => item.kind === "detail_row_visibility_candidate");
  assert.ok(opportunity.suggestedPatchShape);
  assert.match(opportunity.safeDecision, /fixed-source evidence proves the complete event binding and every source effect/);
  // This is a prompt-shape counterexample, not source/trust authorization.
  assertSourceGate(source, example, stateAction(draft).id);
});
