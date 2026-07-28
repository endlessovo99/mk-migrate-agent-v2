import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import {
  inspectDeterministicScriptBranchProof
} from "../../src/dsl/deterministic-script-translations.js";
import {
  detailMainRowLifecycleCandidates
} from "../../src/translator/detail-main-row-lifecycle.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import {
  draftMkScriptsFromSourceScripts
} from "../../src/translator/sysform-jsp-scripts.js";
import { formAttr, projectTemplate } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture =
  "tests/fixtures/route-validation/detail-main-row-lifecycle/route-detail-main-row-lifecycle_SysFormTemplate.xml";
const basis = "deterministic-detail-main-row-lifecycle";
const table = "${table:detailList}";
const originalTriggerId = "spbm_control_identifier_longer_than_limit";
const originalStateId = "fd_spbm_state_identifier_longer_than_limit";

describe("detail-column to main-row lifecycle Route case", () => {
  it("binds the detail event to its table and preserves row reset plus load restoration", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(sourceDraft);
    const detail = dsl.form.fields.find((field) => field.id === "detailList");
    const trigger = detail.columns.find((column) =>
      column.sourceProps?.originalId === originalTriggerId
    );
    const state = detail.columns.find((column) =>
      column.sourceProps?.originalId === originalStateId
    );
    const actions = dsl.scripts.actions.filter((action) =>
      action.functionMappings?.some((mapping) => mapping.basis === basis)
    );

    assert.ok(trigger);
    assert.ok(state);
    assert.notEqual(trigger.id, originalTriggerId);
    assert.notEqual(state.id, originalStateId);
    assert.equal(actions.length, 2, JSON.stringify({
      actions: dsl.scripts.actions.map(actionSummary),
      warnings: dsl.scripts.warnings
    }));

    const change = actions.find((action) => action.event === "onChange");
    const load = actions.find((action) => action.event === "onLoad");
    assert.ok(change);
    assert.ok(load);
    assert.equal(change.scope, "control");
    assert.equal(change.tableId, "detailList");
    assert.equal(change.controlId, trigger.id);
    assert.equal(load.scope, "global");

    for (const action of actions) {
      assert.equal(action.translationStatus, "mapped");
      assert.deepEqual(action.coverage, {
        status: "translated",
        nativeRules: [],
        residuals: []
      });
      assert.equal(action.deterministicBranchProof?.basis, basis);
      assert.equal(
        inspectDeterministicScriptBranchProof(action, {
          calculationDecisions: dsl.scripts.calculationDecisions
        }).ok,
        true
      );
    }

    assert.equal(
      change.function.includes(
        `MKXFORM.updateControl(${JSON.stringify(`${table}.${state.id}`)}`
      ),
      true
    );
    assert.match(change.function, /MKXFORM\.setValue\("fd_project", ""\)/);
    assert.match(change.function, /MKXFORM\.setValue\("fd_tax_number", ""\)/);
    assert.doesNotMatch(change.function, /MKXFORM\.setValue\("label_building"/);
    assert.match(change.function, /MKXFORM\.setFieldAttr\("invoice_row5", 5\)/);
    assert.match(change.function, /MKXFORM\.setFieldAttr\("invoice_row5", 3\)/);
    assert.match(load.function, /for \(var rowNum = 0; rowNum < rows\.length; rowNum \+= 1\)/);
    assert.equal(
      load.function.includes(`rows[rowNum][${JSON.stringify(state.id)}]`),
      true
    );
    assert.match(change.function, /if \(value == 3050100000000000000\)/);
    assert.match(load.function, /if \(value == "3050100000000000000"\)/);
    assert.doesNotMatch(change.function, /String\(value\)/);
    assert.equal(
      dsl.scripts.warnings.some((warning) =>
        warning.code === "script.detail_control_table_required"
      ),
      false
    );
    assert.equal(
      (dsl.formRules?.linkage || []).some((rule) =>
        rule.meta?.sourceJsp?.includes("fdDisplayJsp")
      ),
      false,
      JSON.stringify(dsl.formRules)
    );
    assert.equal(
      checkDraft(dsl).diagnostics.some((diagnostic) => diagnostic.level === "error"),
      false,
      JSON.stringify(checkDraft(dsl).diagnostics)
    );
  });

  it("trusts, persists, and reads back both lifecycle actions through fake NewOA", async () => {
    const result = await runRouteCase("detail-main-row-lifecycle-success");
    const expected = result.dsl.scripts.actions.filter((action) =>
      action.functionMappings?.some((mapping) => mapping.basis === basis)
    );
    const observed = result.execution.readback.form.scripts.actions;

    assert.equal(result.dsl.trust.executable, true);
    assert.equal(expected.length, 2);
    assert.equal(observed.length, 2);
    const persistedActions = JSON.stringify(
      formAttr(projectTemplate(result.dsl)).controlAction
    );
    assert.equal(
      persistedActions.includes("invoice_row"),
      false,
      persistedActions
    );
    assert.equal(
      persistedActions.includes('MKXFORM.setValue(\\"fd_project\\", \\"\\")'),
      true
    );
  });

  it("fails closed when a legacy row helper is callback-shadowed", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(sourceDraft);
    const source = structuredClone(sourceDraft.scripts.sources.find((candidate) =>
      candidate.javascript.includes("AttachXFormValueChangeEventById")
    ));
    source.javascript = source.javascript.replace(
      "function(value, domElement)",
      "function(value, domElement, common_dom_row_set_show_required_reset)"
    );

    assert.deepEqual(
      detailMainRowLifecycleCandidates(source, dsl.form),
      []
    );
  });

  it("requires a uniquely matched value-change sibling before translating load restoration", () => {
    const sourceDraft = cleanSourceFile(fixture);
    sourceDraft.scripts.sources = sourceDraft.scripts.sources.filter((source) =>
      !source.javascript.includes("common_dom_row_set_show_required_reset") ||
      !source.javascript.includes("AttachXFormValueChangeEventById")
    );
    const dsl = draftSourceDraft(sourceDraft);

    assert.equal(
      dsl.scripts.actions.some((action) =>
        action.event === "onLoad" &&
        action.functionMappings?.some((mapping) => mapping.basis === basis)
      ),
      false,
      JSON.stringify(dsl.scripts)
    );

    const wrongOwner = cleanSourceFile(fixture);
    for (const source of wrongOwner.scripts.sources) {
      source.sourceKey = "fdDesignerHtml";
      source.sourceType = "designer-jsp";
      source.fragmentId = source.javascript.includes(
        "AttachXFormValueChangeEventById"
      )
        ? "designer-fragment-change"
        : "designer-fragment-load";
    }
    const wrongOwnerDsl = draftSourceDraft(wrongOwner);
    assert.equal(
      wrongOwnerDsl.scripts.actions.some((action) =>
        action.event === "onLoad" &&
        action.functionMappings?.some((mapping) => mapping.basis === basis)
      ),
      false,
      JSON.stringify(wrongOwnerDsl.scripts)
    );
  });

  it("uses the same d_ alias expansion for remapped state reads and writes", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const legacyStateAlias = originalStateId.slice(1);
    for (const source of sourceDraft.scripts.sources) {
      source.javascript = source.javascript.replaceAll(
        originalStateId,
        legacyStateAlias
      );
    }
    const dsl = draftSourceDraft(sourceDraft);
    const actions = dsl.scripts.actions.filter((action) =>
      action.functionMappings?.some((mapping) => mapping.basis === basis)
    );

    assert.equal(actions.length, 2, JSON.stringify(dsl.scripts));
    assert.equal(actions.some((action) => action.event === "onLoad"), true);
  });

  it("qualifies a unique detail target centrally for a non-lifecycle action", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const source = sourceDraft.scripts.sources.find((candidate) =>
      candidate.javascript.includes("AttachXFormValueChangeEventById")
    );
    source.javascript = [
      `AttachXFormValueChangeEventById("${originalTriggerId}", function(value) {`,
      '  SetXFormFieldValueById("fd_project", value);',
      "});"
    ].join("\n");
    const dsl = draftSourceDraft(sourceDraft);
    const detail = dsl.form.fields.find((field) => field.id === "detailList");
    const trigger = detail.columns.find((column) =>
      column.sourceProps?.originalId === originalTriggerId
    );
    const action = dsl.scripts.actions.find((candidate) =>
      candidate.event === "onChange"
    );

    assert.ok(action, JSON.stringify(dsl.scripts));
    assert.equal(action.tableId, "detailList");
    assert.equal(action.controlId, trigger.id);
    assert.equal(
      dsl.scripts.warnings.some((warning) =>
        warning.code === "script.detail_control_table_required"
      ),
      false
    );
  });

  it("fails closed when a main-form alias makes the detail trigger ambiguous", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(sourceDraft);
    const source = sourceDraft.scripts.sources.find((candidate) =>
      candidate.javascript.includes("common_dom_row_set_show_required_reset") &&
      candidate.javascript.includes("AttachXFormValueChangeEventById")
    );
    const form = structuredClone(dsl.form);
    form.fields.push({
      id: "fd_ambiguous_main",
      type: "text",
      componentId: "xform-textfield",
      sourceProps: { originalId: originalTriggerId }
    });

    assert.deepEqual(
      detailMainRowLifecycleCandidates(source, form, sourceDraft.scripts),
      []
    );
  });

  it("does not let d_ main-field canonicalization bypass detail ambiguity", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [{
        id: "ambiguous.script.1",
        sourceRef: "source.form.jsp.ambiguous.script.1",
        sourceKey: "ambiguous",
        sourceType: "designer-jsp",
        javascript: [
          'AttachXFormValueChangeEventById("d_conflict", function(value) {',
          '  SetXFormFieldValueById("fd_target", value);',
          "});"
        ].join("\n"),
        functionAudit: { matched: [], violations: [] }
      }]
    }, {
      form: {
        fields: [
          {
            id: "fd_conflict",
            type: "text",
            componentId: "xform-textfield"
          },
          {
            id: "fd_target",
            type: "text",
            componentId: "xform-textfield"
          },
          {
            id: "detailList",
            type: "detailTable",
            componentId: "xform-detail",
            columns: [{
              id: "d_conflict",
              type: "text",
              componentId: "xform-textfield"
            }]
          }
        ]
      }
    });

    assert.equal(scripts.actions.length, 0, JSON.stringify(scripts));
    assert.equal(scripts.warnings[0]?.code, "script.control_target_ambiguous");
  });

  it("preserves strict and loose comparison semantics exactly", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const source = structuredClone(sourceDraft.scripts.sources.find((candidate) =>
      candidate.javascript.includes("common_dom_row_set_show_required_reset") &&
      candidate.javascript.includes("AttachXFormValueChangeEventById")
    ));
    const form = draftSourceDraft(sourceDraft).form;
    const loose = detailMainRowLifecycleCandidates(source, form, sourceDraft.scripts)[0];
    source.javascript = source.javascript.replace(
      "value == 3050100000000000000",
      "value === 3050100000000000000"
    );
    const strict = detailMainRowLifecycleCandidates(source, form, sourceDraft.scripts)[0];

    assert.match(loose.function, /value == 3050100000000000000/);
    assert.match(strict.function, /value === 3050100000000000000/);
    assert.doesNotMatch(strict.function, /String\(value\)/);
  });

  it("preserves unsafe integer assignment tokens and rejects unsupported writes", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const original = sourceDraft.scripts.sources.find((candidate) =>
      candidate.javascript.includes("common_dom_row_set_show_required_reset") &&
      candidate.javascript.includes("AttachXFormValueChangeEventById")
    );
    const form = draftSourceDraft(sourceDraft).form;
    const numeric = structuredClone(original);
    numeric.javascript = numeric.javascript.replace(
      '"3050100000000000000"',
      "9007199254740993"
    );
    const numericAction = detailMainRowLifecycleCandidates(
      numeric,
      form,
      sourceDraft.scripts
    )[0];
    assert.match(numericAction.function, /9007199254740993/);
    assert.doesNotMatch(numericAction.function, /9007199254740992/);

    for (const replacement of [
      '"3050100000000000000", "ignored"',
      "/unsafe/",
      "9007199254740993n"
    ]) {
      const unsupported = structuredClone(original);
      unsupported.javascript = unsupported.javascript.replace(
        '"3050100000000000000"',
        replacement
      );
      assert.deepEqual(
        detailMainRowLifecycleCandidates(
          unsupported,
          form,
          sourceDraft.scripts
        ),
        []
      );
    }
  });
});

function actionSummary(action) {
  return {
    id: action.id,
    event: action.event,
    scope: action.scope,
    tableId: action.tableId,
    controlId: action.controlId,
    status: action.translationStatus,
    bases: action.functionMappings?.map((mapping) => mapping.basis)
  };
}
