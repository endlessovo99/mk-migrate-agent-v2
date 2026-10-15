import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  applyEvidenceBackedPatches,
  collectSourceRefs
} from "../../src/agent-review/review-validation.js";
import { buildScriptBranchProvenance } from "../../src/dsl/script-branch-provenance.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { sampleDraftDsl, sampleSourceDraft } from "../helpers/sample-dsl.js";

const fixture = JSON.parse(readFileSync(new URL(
  "../fixtures/route-validation/native-row-alias-coverage/fixture.json",
  import.meta.url
), "utf8"));

describe("native row alias coverage Route-validation", () => {
  it("accepts equal effects on aliases of one layout row without rewriting native rules", () => {
    const { source, draft, patches } = scenario();
    const originalRules = structuredClone(draft.formRules);
    const result = applyEvidenceBackedPatches(draft, patches, {
      sourceRefs: collectSourceRefs(source),
      sourceDraft: source
    });

    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.dslDraft.formRules, originalRules);
    assert.deepEqual(draft.formRules, originalRules);
    assert.equal(result.dslDraft.scripts.actions[0].function, fixture.reviewedFunction);
    const checked = checkDraft(result.dslDraft);
    assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  });

  for (const branch of ["effects", "else"]) {
    it(`rejects conflicting alias values in the ${branch} branch`, () => {
      const input = scenario();
      const effects = input.draft.formRules.linkage[0][branch];
      const effect = effects.find(item => item.target === "row_alias" && item.type === "visible");
      effect.value = !effect.value;
      assertRejected(input, "agent.patch.row_marker_native_coverage_incomplete");
    });
  }

  it("rejects a missing required else state across all aliases", () => {
    const input = scenario();
    const rule = input.draft.formRules.linkage[0];
    rule.else = rule.else.filter(effect => effect.type !== "required");
    assertRejected(input, "agent.patch.row_marker_native_coverage_incomplete");
  });

  it("rejects a missing visible dimension across both branches", () => {
    const input = scenario();
    const rule = input.draft.formRules.linkage[0];
    for (const branch of ["effects", "else"]) {
      rule[branch] = rule[branch].filter(effect => effect.type !== "visible");
    }
    assertRejected(input, "agent.patch.row_marker_native_coverage_incomplete");
  });

  it("rejects rules from another action boundary", () => {
    const input = scenario();
    input.draft.formRules.linkage[0].meta.sourceActionKey = `${fixture.sourceRef}#onChange@99`;
    assertRejected(input, "agent.patch.native_rule_action_mismatch");
  });

  it("rejects two native rule writers even when their values agree", () => {
    const input = scenario();
    const duplicate = structuredClone(input.draft.formRules.linkage[0]);
    duplicate.id = "linkage.fd_mode.second-writer";
    input.draft.formRules.linkage.push(duplicate);
    input.draft.scripts.actions[0].coverage.nativeRules.push(duplicate.id);
    input.patches.find(patch => patch.path.endsWith("/coverage")).value.nativeRules.push(duplicate.id);
    assertRejected(input, "agent.patch.row_marker_native_coverage_incomplete");
  });

  it("keeps reset=true blocked without a proven reset mapping", () => {
    const input = scenario();
    const before = 'common_dom_row_set_show_required_reset("row_primary", true, true, false)';
    const after = 'common_dom_row_set_show_required_reset("row_primary", true, true, true)';
    input.source.scripts.sources[0].javascript = fixture.sourceJavascript.replace(before, after);
    input.draft.scripts.actions[0].function = input.draft.scripts.actions[0].function.replace(before, after);
    assertRejected(input, "agent.patch.row_marker_reset_untranslated");
  });
});

function assertRejected({ source, draft, patches }, code) {
  const result = applyEvidenceBackedPatches(draft, patches, {
    sourceRefs: collectSourceRefs(source),
    sourceDraft: source
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.some(item => item.code === code), true, JSON.stringify(result.diagnostics));
}

function scenario() {
  const ids = ["fd_mode", "fd_marker", "fd_payload"];
  const controls = ids.map(id => ({ id, sourceRef: `source.form.control.${id}` }));
  const source = sampleSourceDraft({
    workflow: undefined,
    form: { controls, detailTables: [] },
    scripts: {
      source: "sysform-jsp",
      sources: [{
        id: "native-row-alias.script.1",
        sourceRef: fixture.sourceRef,
        javascript: fixture.sourceJavascript,
        functionAudit: { matched: [], violations: [] }
      }]
    }
  });
  const nativeRuleId = "linkage.fd_mode.eq.A";
  const action = {
    id: "native-row-alias.script.1.event.1",
    name: "onChange",
    event: "onChange",
    scope: "control",
    controlId: "fd_mode",
    sourceRefs: [fixture.sourceRef],
    sourceActionKey: fixture.sourceActionKey,
    branchProvenance: buildScriptBranchProvenance({
      event: "onChange",
      source: fixture.sourceJavascript,
      sourceRef: fixture.sourceRef,
      sourceActionKey: fixture.sourceActionKey
    }),
    function: [
      "function onChange(value) {",
      "  // Source JSP JavaScript:",
      ...fixture.sourceJavascript.split("\n").map(line => `  // ${line}`),
      "}"
    ].join("\n"),
    translationStatus: "needs_review",
    functionMappings: [],
    coverage: {
      status: "partial",
      nativeRules: [nativeRuleId],
      residuals: [{
        code: "script.residual.form_rule_behavior_uncovered",
        sourceRef: fixture.sourceRef,
        evidence: "SetXFormFieldValueById(\"fd_marker\", value, false);"
      }]
    }
  };
  const effects = value => fixture.markerAliases.flatMap(target => [
    { type: "visible", target, value },
    { type: "required", target, value }
  ]);
  const draft = sampleDraftDsl({
    workflow: undefined,
    form: {
      fields: ids.map(id => ({
        id, title: id, type: "text", componentId: "xform-input", props: {},
        sourceProps: { designerType: "inputText" },
        sourceRef: `source.form.control.${id}`
      })),
      layout: {
        sourceGrid: {
          source: "fdDesignerHtml",
          rows: [
            { id: "row-0", sourceRef: "source.form.layout.row.row-0", cells: [
              { id: "row-0-cell-0", sourceRef: "source.form.layout.cell.row-0-cell-0", references: [{ referenceId: "fd_mode" }] },
              { id: "row-0-cell-1", sourceRef: "source.form.layout.cell.row-0-cell-1", references: [{ referenceId: "fd_marker" }] }
            ] },
            { id: "row-1", sourceRef: "source.form.layout.row.row-1", cells: [
              { id: "row-1-cell-0", sourceRef: "source.form.layout.cell.row-1-cell-0", references: [{ referenceId: "fd_payload" }] }
            ] }
          ]
        },
        mkTree: [{
          id: "layout.row-0", componentId: "xform-flex-1-2-layout",
          props: { columns: 2, sourceColumns: 2 },
          sourceRef: "source.form.layout.row.row-0",
          children: [
            { id: "layout.row-0-cell-0", refType: "field", refIds: ["fd_mode"], sourceRef: "source.form.layout.cell.row-0-cell-0", column: 0, colspan: 1 },
            { id: "layout.row-0-cell-1", refType: "field", refIds: ["fd_marker"], sourceRef: "source.form.layout.cell.row-0-cell-1", column: 1, colspan: 1 }
          ]
        }, {
          id: "layout.row-1",
          componentId: "xform-flex-1-1-layout",
          props: { columns: 1, sourceColumns: 1 },
          sourceMarkers: fixture.markerAliases,
          sourceRef: "source.form.layout.row.row-1",
          children: [{
            id: "layout.row-1-cell-0", refType: "field", refIds: ["fd_payload"],
            sourceRef: "source.form.layout.cell.row-1-cell-0", column: 0, colspan: 1
          }]
        }]
      }
    },
    formRules: {
      linkage: [{
        id: nativeRuleId, trigger: "change", source: "fd_mode", logic: "and",
        when: [{ field: "fd_mode", op: "eq", value: "A" }],
        effects: effects(true), else: effects(false),
        translationStatus: "executable",
        meta: { sourceJsp: fixture.sourceRef, sourceActionKey: fixture.sourceActionKey }
      }]
    },
    scripts: { source: "sysform-jsp", actions: [action] }
  });
  const patch = (property, value) => ({
    op: "replace", path: `/scripts/actions/0/${property}`, value,
    sourceRefs: [fixture.sourceRef], confidence: 0.95,
    evidence: ["The native rule retains both aliases and both visible/required branches."],
    rationale: "Keep native row effects and translate only the source field assignment."
  });
  const patches = [
    patch("function", fixture.reviewedFunction),
    patch("translationStatus", "mapped"),
    patch("functionMappings", [{
      source: "SetXFormFieldValueById", target: "MKXFORM.setValue",
      basis: "semantic-translation", reviewRequired: false
    }]),
    patch("coverage", { status: "translated", nativeRules: [nativeRuleId], residuals: [] })
  ];
  return { source, draft, patches };
}
