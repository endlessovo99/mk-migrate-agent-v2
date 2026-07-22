import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyEvidenceBackedPatches,
  collectSourceRefs
} from "../../src/agent-review/review-validation.js";
import {
  analyzeScriptBranchConditions,
  buildScriptBranchProvenance,
  inspectMappedScriptBranchProvenance
} from "../../src/dsl/script-branch-provenance.js";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import {
  buildDeterministicScriptBranchProof,
  deterministicManualResidualDecisionId
} from "../../src/dsl/deterministic-script-translations.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import {
  sampleDraftDsl,
  sampleForm,
  sampleSourceDraft,
  sampleTrustedDsl
} from "../helpers/sample-dsl.js";

const sourceRef = "source.form.jsp.generic-branch";

describe("action-level branch operand provenance", () => {
  it("rejects unrelated declared operands for ordinary onChange and onLoad actions", () => {
    for (const testCase of [onChangeCase(), onLoadCase()]) {
      const { sourceDraft, dslDraft, functionText } = testCase;
      const rejected = applyEvidenceBackedPatches(
        dslDraft,
        mappedActionPatches(dslDraft.scripts.actions[0], functionText),
        { sourceRefs: collectSourceRefs(sourceDraft), sourceDraft }
      );

      assert.equal(rejected.ok, false, testCase.event);
      assert.equal(
        rejected.diagnostics.some((item) => (
          item.code === "agent.patch.condition_operand_provenance_unverified"
        )),
        true,
        JSON.stringify(rejected.diagnostics)
      );

      const forged = structuredClone(dslDraft);
      forged.scripts.actions[0].function = functionText;
      forged.scripts.actions[0].translationStatus = "mapped";
      forged.scripts.actions[0].coverage = { status: "translated", nativeRules: [], residuals: [] };
      forged.scripts.actions[0].functionMappings = [mappingEvidence()];
      const draftCheck = checkDraft(forged);
      assert.equal(draftCheck.ok, false, testCase.event);
      assert.equal(
        draftCheck.diagnostics.some((item) => (
          item.code === "dsl.scripts.condition_operand_provenance_unverified"
        )),
        true,
        JSON.stringify(draftCheck.diagnostics)
      );
    }
  });

  it("accepts provable alias, array-first, and String derivations, including onLoad boolean aliases used by ternaries", () => {
    for (const testCase of [validOnChangeCase(), validOnLoadCase()]) {
      const { sourceDraft, dslDraft, functionText } = testCase;
      const accepted = applyEvidenceBackedPatches(
        dslDraft,
        mappedActionPatches(dslDraft.scripts.actions[0], functionText),
        { sourceRefs: collectSourceRefs(sourceDraft), sourceDraft }
      );

      assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));
      assert.equal(checkDraft(accepted.dslDraft).ok, true, testCase.event);
    }
  });

  it("accepts a traceable two-value early-return guard with a deduplicated boolean alias", () => {
    const testCase = actionCase({
      event: "onChange",
      source: [
        "AttachXFormValueChangeEventById('fd_subject', function(value) {",
        "  if (value == 11) legacySet('first');",
        "  else if (value == 22) legacySet('second');",
        "})"
      ].join("\n"),
      functionText: [
        "function onChange(value) {",
        "  var selected = Array.isArray(value) ? value[0] : value",
        "  var normalized = String(selected)",
        "  if (normalized !== '11' && normalized !== '22') return",
        "  var first = normalized === '11'",
        "  MKXFORM.setValue('fd_amount', first ? 'first' : 'second')",
        "}"
      ].join("\n")
    });
    const accepted = applyEvidenceBackedPatches(
      testCase.dslDraft,
      mappedActionPatches(testCase.dslDraft.scripts.actions[0], testCase.functionText),
      { sourceRefs: collectSourceRefs(testCase.sourceDraft), sourceDraft: testCase.sourceDraft }
    );

    assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));
    assert.equal(checkDraft(accepted.dslDraft).ok, true);
  });

  it("keeps source and target scripts with no branches compatible", () => {
    const action = genericAction({
      event: "onChange",
      source: "AttachXFormValueChangeEventById('fd_subject', function(value) { legacySync(value); })"
    });
    action.function = "function onChange(value) { MKXFORM.setValue('fd_amount', value) }";
    action.translationStatus = "mapped";

    assert.equal(action.branchProvenance.status, "none");
    assert.equal(inspectMappedScriptBranchProvenance(action).ok, true);
  });

  it("traces an onLoad field operand through a directly scheduled timer callback", () => {
    const source = [
      "Com_AddEventListener(window, 'load', function() {",
      "  setTimeout(function() {",
      "    var current = GetXFormFieldById('fd_subject')[0].value",
      "    if (current === 'A') legacySet('matched')",
      "  }, 10)",
      "})"
    ].join("\n");
    const result = analyzeScriptBranchConditions(source, { event: "onLoad" });

    assert.equal(result.status, "proven", JSON.stringify(result));
    assert.deepEqual(result.conditions.map((condition) => condition.origin), ["field:fd_subject"]);
  });

  it("rejects a branch inside a callback passed to a shadowed timer lookalike", () => {
    const source = [
      "function setTimeout(callback) { callback() }",
      "Com_AddEventListener(window, 'load', function() {",
      "  setTimeout(function() {",
      "    var current = GetXFormFieldById('fd_subject')[0].value",
      "    if (current === 'A') legacySet('matched')",
      "  }, 10)",
      "})"
    ].join("\n");
    const result = analyzeScriptBranchConditions(source, { event: "onLoad" });

    assert.equal(result.status, "unproven", JSON.stringify(result));
    assert.equal(result.reason, "nested_callable_branch_not_statically_supported");
  });

  it("rejects a condition alias declared only inside a nested decoy function", () => {
    const { sourceDraft, dslDraft } = validOnLoadCase();
    const decoyFunction = [
      "function onLoad() {",
      "  function decoy() {",
      "    var current = MKXFORM.getValue('fd_subject')",
      "    var showMatched = current === 'A'",
      "  }",
      "  MKXFORM.setValue('fd_amount', showMatched ? 'matched' : 'other')",
      "}"
    ].join("\n");
    const rejected = applyEvidenceBackedPatches(
      dslDraft,
      mappedActionPatches(dslDraft.scripts.actions[0], decoyFunction),
      { sourceRefs: collectSourceRefs(sourceDraft), sourceDraft }
    );

    assert.equal(rejected.ok, false);
    const diagnostic = rejected.diagnostics.find((item) => (
      item.code === "agent.patch.condition_operand_provenance_unverified"
    ));
    assert.ok(diagnostic, JSON.stringify(rejected.diagnostics));
    assert.equal(diagnostic.details.observed.status, "unproven");
    assert.equal(
      diagnostic.details.observed.reason,
      "ternary_condition_not_statically_supported"
    );
  });

  it("does not allow an unproven source branch to become omitted", () => {
    const source = [
      "AttachXFormValueChangeEventById('fd_subject', function(value) {",
      "  var unrelated = GetXFormFieldById('fd_amount')[0].value",
      "  if (unrelated === 'A') legacySet('matched');",
      "})"
    ].join("\n");
    const action = genericAction({ event: "onChange", source });
    assert.equal(action.branchProvenance.status, "unproven");
    action.function = "";
    action.translationStatus = "omitted";
    action.coverage = {
      status: "covered",
      nativeRules: [],
      staticProps: [{ fieldId: "fd_subject", prop: "required", value: true }],
      residuals: []
    };
    action.functionMappings = [{
      source: "legacy conditional action",
      target: "static form property",
      basis: "static-form-prop",
      reviewRequired: false
    }];
    const dslDraft = sampleDraftDsl({ scripts: { source: "sysform-jsp", actions: [action] } });
    const result = checkDraft(dslDraft);

    assert.equal(result.ok, false);
    assert.equal(
      result.diagnostics.some((item) => (
        item.code === "dsl.scripts.condition_operand_provenance_unverified"
      )),
      true,
      JSON.stringify(result.diagnostics)
    );
  });

  it("rejects boolean aliases after reassignment and expression-arrow parameter shadowing", () => {
    const scripts = [
      [
        "function onChange(value) {",
        "  let show = value === 'A'",
        "  show = MKXFORM.getValue('fd_amount') === 'A'",
        "  if (show) MKXFORM.setValue('fd_amount', 'matched')",
        "}"
      ].join("\n"),
      [
        "function onLoad() {",
        "  let current = MKXFORM.getValue('fd_subject')",
        "  let show = current === 'A'",
        "  show = MKXFORM.getValue('fd_amount') === 'A'",
        "  if (show) MKXFORM.setValue('fd_amount', 'matched')",
        "}"
      ].join("\n"),
      [
        "function onChange(value) {",
        "  const show = value === 'A'",
        "  return [false].map(show => show ? 'matched' : 'other')",
        "}"
      ].join("\n")
    ];

    for (const source of scripts) {
      const event = source.includes("onLoad") ? "onLoad" : "onChange";
      assert.equal(
        analyzeScriptBranchConditions(source, { event }).status,
        "unproven",
        source
      );
    }
  });

  it("rejects logical/destructuring writes, member mutation, and unknown-call escape", () => {
    const scripts = [
      "let selected=value; selected ||= MKXFORM.getValue('fd_amount'); if(selected === 'A'){}",
      "let selected=value; [selected]=[MKXFORM.getValue('fd_amount')]; if(selected === 'A'){}",
      "let selected=value; ({selected}={selected: MKXFORM.getValue('fd_amount')}); if(selected === 'A'){}",
      "let selected=value; selected[0]='wrong'; if(selected[0] === 'A'){}",
      "let selected=value; mutate(selected); if(selected[0] === 'A'){}",
      "let selected=value; let alias=selected; alias[0]='wrong'; if(selected[0] === 'A'){}",
      "let alias; alias=value; alias[0]='wrong'; if(value[0] === 'A'){}",
      "const box={ selected:value }; box.selected[0]='wrong'; if(value[0] === 'A'){}",
      "const capture=()=>value; sink(capture); if(value[0] === 'A'){}"
    ];

    for (const body of scripts) {
      const source = `function onChange(value) { ${body} }`;
      assert.equal(
        analyzeScriptBranchConditions(source, { event: "onChange" }).status,
        "unproven",
        source
      );
    }
  });

  it("rejects shadowed field readers and built-in derivation helpers", () => {
    const scripts = [
      "function onLoad(MKXFORM) { if (MKXFORM.getValue('fd_subject') === 'A') {} }",
      "function onLoad() { const String = x => 'A'; const raw=MKXFORM.getValue('fd_subject'); if (String(raw) === 'A') {} }",
      "function onChange(value) { const Array={isArray:()=>false}; const first=Array.isArray(value) ? value[0] : value; if(first === 'A'){} }"
    ];
    for (const source of scripts) {
      const event = source.includes("onChange") ? "onChange" : "onLoad";
      assert.equal(analyzeScriptBranchConditions(source, { event }).status, "unproven", source);
    }
  });

  it("finds short-circuit and template-interpolation branches through the AST", () => {
    const shortCircuit = [
      "function onChange(value) {",
      "  value === 'A' && MKXFORM.setValue('fd_amount', 'matched')",
      "}"
    ].join("\n");
    const templateWrong = [
      "function onChange(value) {",
      "  const wrong = MKXFORM.getValue('fd_amount')",
      "  MKXFORM.setValue('fd_subject', `${wrong === 'A' ? 'matched' : 'other'}`)",
      "}"
    ].join("\n");
    const templateCorrect = [
      "function onChange(value) {",
      "  MKXFORM.setValue('fd_subject', `${value === 'A' ? 'matched' : 'other'}`)",
      "}"
    ].join("\n");

    assert.equal(analyzeScriptBranchConditions(shortCircuit, { event: "onChange" }).status, "unproven");
    assert.equal(analyzeScriptBranchConditions(templateWrong, { event: "onChange" }).status, "unproven");
    assert.equal(analyzeScriptBranchConditions(templateCorrect, { event: "onChange" }).status, "proven");
  });

  it("fails closed for branches hidden behind object coercion hooks", () => {
    const source = "AttachXFormValueChangeEventById('fd_subject', function(value) { legacySync(value); })";
    const expected = buildScriptBranchProvenance({ event: "onChange", source });
    assert.equal(expected.status, "none");

    for (const [label, hook] of [
      ["toString", "toString: function()"],
      ["valueOf", "valueOf: function()"],
      ["Symbol.toPrimitive", "[Symbol.toPrimitive]: function()"]
    ]) {
      const functionText = [
        "function onChange(value) {",
        `  String({ ${hook} {`,
        "    var unrelated = MKXFORM.getValue('fd_amount')",
        "    if (unrelated === 'A') MKXFORM.setValue('fd_subject', 'matched')",
        "    return ''",
        "  } })",
        "}"
      ].join("\n");
      const action = {
        event: "onChange",
        function: functionText,
        translationStatus: "mapped",
        branchProvenance: expected
      };
      const observed = analyzeScriptBranchConditions(functionText, { event: "onChange" });
      const inspection = inspectMappedScriptBranchProvenance(action);

      assert.equal(observed.status, "unproven", `${label}: ${JSON.stringify(observed)}`);
      assert.equal(observed.reason, "nested_coercion_branch_not_statically_supported", label);
      assert.equal(inspection.ok, false, label);
      assert.equal(inspection.reason, "source_unconditional_target_conditional", label);
    }

    for (const [label, assignment] of [
      ["assigned toString", "object.toString = function()"],
      ["assigned valueOf", "object.valueOf = () =>"],
      ["assigned Symbol.toPrimitive", "object[Symbol.toPrimitive] = function()"]
    ]) {
      const functionText = [
        "function onChange(value) {",
        "  var object = {}",
        `  ${assignment} {`,
        "    var unrelated = MKXFORM.getValue('fd_amount')",
        "    if (unrelated === 'A') MKXFORM.setValue('fd_subject', 'matched')",
        "    return ''",
        "  }",
        "  String(object)",
        "}"
      ].join("\n");
      const action = {
        event: "onChange",
        function: functionText,
        translationStatus: "mapped",
        branchProvenance: expected
      };
      const observed = analyzeScriptBranchConditions(functionText, { event: "onChange" });

      assert.equal(observed.status, "unproven", `${label}: ${JSON.stringify(observed)}`);
      assert.equal(observed.reason, "nested_coercion_branch_not_statically_supported", label);
      assert.equal(inspectMappedScriptBranchProvenance(action).ok, false, label);
    }

    const logicalAssignmentHook = [
      "function onChange(value) {",
      "  String({ toString: function() {",
      "    var unrelated = MKXFORM.getValue('fd_amount')",
      "    unrelated &&= MKXFORM.setValue('fd_subject', 'matched')",
      "    return ''",
      "  } })",
      "}"
    ].join("\n");
    assert.equal(
      analyzeScriptBranchConditions(logicalAssignmentHook, { event: "onChange" }).status,
      "unproven",
      logicalAssignmentHook
    );
  });

  it("treats logical assignment operators as conditional execution", () => {
    const source = "AttachXFormValueChangeEventById('fd_subject', function(value) { legacySync(value); })";
    const expected = buildScriptBranchProvenance({ event: "onChange", source });

    for (const operator of ["&&=", "||=", "??="]) {
      const functionText = [
        "function onChange(value) {",
        "  var unrelated = MKXFORM.getValue('fd_amount')",
        `  unrelated ${operator} MKXFORM.setValue('fd_subject', 'matched')`,
        "}"
      ].join("\n");
      const action = {
        event: "onChange",
        function: functionText,
        translationStatus: "mapped",
        branchProvenance: expected
      };
      const observed = analyzeScriptBranchConditions(functionText, { event: "onChange" });

      assert.notEqual(observed.status, "none", `${operator}: ${JSON.stringify(observed)}`);
      assert.equal(inspectMappedScriptBranchProvenance(action).ok, false, operator);
    }
  });

  it("does not accept member or locally shadowed lookalikes as the onChange entrypoint", () => {
    const scripts = [
      "fake.AttachXFormValueChangeEventById('fd_subject', function(value){ if(value === 'A'){} })",
      "function AttachXFormValueChangeEventById(id, callback){ callback('A') } AttachXFormValueChangeEventById('fd_subject', function(value){ if(value === 'A'){} })"
    ];
    for (const source of scripts) {
      assert.equal(analyzeScriptBranchConditions(source, { event: "onChange" }).status, "unproven");
    }
  });

  it("requires branch provenance at the draft branch boundary and for every executable onChange/onLoad action", () => {
    const action = genericAction({
      event: "onChange",
      source: "AttachXFormValueChangeEventById('fd_subject', function(value) { if (value === 'A') legacySet(); })"
    });
    action.function = "function onChange(value) { const wrong=MKXFORM.getValue('fd_amount'); if(wrong === 'A'){} }";
    action.translationStatus = "mapped";
    action.coverage = { status: "translated", nativeRules: [], residuals: [] };
    action.functionMappings = [mappingEvidence()];
    delete action.branchProvenance;

    const draftCheck = checkDraft(sampleDraftDsl({ scripts: { source: "sysform-jsp", actions: [action] } }));
    assert.equal(draftCheck.ok, false);
    assert.equal(draftCheck.diagnostics.some((item) => item.code === "dsl.scripts.branch_provenance_missing"), true);

    action.function = "function onChange(value) { MKXFORM.setValue('fd_amount', value) }";
    const branchlessDraftCheck = checkDraft(sampleDraftDsl({
      scripts: { source: "sysform-jsp", actions: [action] }
    }));
    assert.equal(branchlessDraftCheck.ok, false);
    assert.equal(
      branchlessDraftCheck.diagnostics.some((item) => item.code === "dsl.scripts.branch_provenance_missing"),
      true
    );
    const executeCheck = checkExecute(sampleTrustedDsl({ scripts: { source: "sysform-jsp", actions: [action] } }));
    assert.equal(executeCheck.ok, false);
    assert.equal(executeCheck.diagnostics.some((item) => item.code === "dsl.scripts.branch_provenance_missing"), true);
  });

  it("does not treat arbitrary, generic, or uncertified known deterministic bases as provenance exemptions", () => {
    for (const basis of [
      "deterministic-forged",
      "deterministic-pattern",
      "deterministic-calculation-assignment"
    ]) {
      const action = {
        id: `forged.${basis}`,
        name: "onChange",
        event: "onChange",
        scope: "control",
        controlId: "fd_subject",
        function: [
          "function onChange(value) {",
          "  var unrelated = MKXFORM.getValue('fd_amount')",
          "  if (unrelated === 'A') MKXFORM.setValue('fd_subject', 'matched')",
          "}"
        ].join("\n"),
        translationStatus: "mapped",
        coverage: { status: "translated", nativeRules: [], residuals: [] },
        functionMappings: [{
          source: "forged compiler recipe",
          target: "conditional assignment",
          basis,
          reviewRequired: false
        }]
      };
      const result = checkExecute(sampleTrustedDsl({
        workflow: undefined,
        scripts: { source: "sysform-jsp", actions: [action] }
      }));

      assert.equal(result.ok, false, basis);
      assert.equal(
        result.diagnostics.some((item) => item.code === "dsl.scripts.branch_provenance_missing"),
        true,
        `${basis}: ${JSON.stringify(result.diagnostics)}`
      );
    }
  });

  it("rejects branchless deterministic claims when no compiler proof exists", () => {
    for (const basis of [
      "deterministic-forged",
      "deterministic-pattern",
      "deterministic-calculation-assignment"
    ]) {
      const action = {
        id: `branchless.${basis}`,
        name: "onChange",
        event: "onChange",
        scope: "control",
        controlId: "fd_subject",
        function: "function onChange(value) { MKXFORM.setValue('fd_subject', MKXFORM.getValue('fd_amount')) }",
        translationStatus: "mapped",
        coverage: { status: "translated", nativeRules: [], residuals: [] },
        functionMappings: [{
          source: "uncertified deterministic claim",
          target: "MKXFORM.setValue",
          basis,
          reviewRequired: false
        }]
      };
      for (const result of [
        checkDraft(sampleDraftDsl({ workflow: undefined, scripts: { actions: [action] } })),
        checkExecute(sampleTrustedDsl({ workflow: undefined, scripts: { actions: [action] } }))
      ]) {
        assert.equal(result.ok, false, basis);
        assert.equal(
          result.diagnostics.some((item) => item.code === "dsl.scripts.deterministic_branch_proof_missing"),
          true,
          `${basis}: ${JSON.stringify(result.diagnostics)}`
        );
      }
    }
  });

  it("requires deterministic button recipes to retain their compiler proof and action binding", () => {
    const form = sampleForm();
    form.fields.push({
      id: "fd_compile",
      title: "生成明细",
      type: "button",
      componentId: "xform-button",
      props: {},
      sourceProps: {},
      sourceRef
    });
    const action = {
      id: "fd_compile.onClick",
      name: "onClick",
      event: "onClick",
      scope: "control",
      controlId: "fd_compile",
      sourceRefs: [sourceRef],
      function: "function onClick() { MKXFORM.deleteRow('${table:fd_detail}') }",
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      semanticHints: { targetDetailTableId: "fd_detail" },
      functionMappings: [{
        source: "compiler-recognized detail row expansion",
        target: "MKXFORM detail rows",
        basis: "deterministic-detail-row-expansion",
        reviewRequired: false
      }]
    };

    const missing = checkDraft(sampleDraftDsl({
      workflow: undefined,
      form,
      scripts: { actions: [action] }
    }));
    assert.equal(missing.ok, false);
    assert.equal(
      missing.diagnostics.some((item) => item.code === "dsl.scripts.deterministic_branch_proof_missing"),
      true,
      JSON.stringify(missing.diagnostics)
    );

    action.deterministicBranchProof = buildDeterministicScriptBranchProof(action);
    assert.ok(action.deterministicBranchProof);
    const executable = sampleTrustedDsl({
      workflow: undefined,
      form,
      scripts: { actions: [action] }
    });
    assert.equal(checkExecute(executable).ok, true);

    for (const mutate of [
      (candidate) => { candidate.function += "\n/* changed */"; },
      (candidate) => { candidate.controlId = "fd_subject"; },
      (candidate) => { candidate.sourceRefs = [...candidate.sourceRefs, "source.form.control.fd_amount"]; }
    ]) {
      const changed = structuredClone(executable);
      mutate(changed.scripts.actions[0]);
      const result = checkExecute(changed);
      assert.equal(result.ok, false);
      assert.equal(
        result.diagnostics.some((item) => item.code === "dsl.scripts.deterministic_branch_proof_invalid"),
        true,
        JSON.stringify(result.diagnostics)
      );
    }
  });

  it("rejects a self-reproved deterministic button when its source binding differs from the rebuilt Source Draft", () => {
    const sourceDraft = cleanSourceFile(
      "tests/fixtures/route-validation/finance-detail-generation/route-finance-detail-generation_SysFormTemplate.xml"
    );
    const dslDraft = draftSourceDraft(sourceDraft);
    const action = dslDraft.scripts.actions.find((candidate) =>
      candidate.functionMappings?.[0]?.basis === "deterministic-finance-detail-generation"
    );
    assert.ok(action?.deterministicBranchProof);

    action.sourceRefs = [...action.sourceRefs, "source.form.control.fd_fixture_status"];
    action.deterministicBranchProof = buildDeterministicScriptBranchProof(action);
    assert.ok(action.deterministicBranchProof);
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      decisions: []
    });
    const result = checkTrust(sourceDraft, trusted);

    assert.equal(result.ok, false);
    assert.equal(
      result.diagnostics.some((item) => item.code === "trust.deterministic_script_source_mismatch"),
      true,
      JSON.stringify(result.diagnostics)
    );
  });

  it("binds deterministic proof to the independently rebuilt Source Draft action", () => {
    const sourceDraft = sampleSourceDraft({
      scripts: {
        source: "sysform-jsp",
        sources: [{
          id: "generic-branch",
          sourceRef,
          javascript: "AttachXFormValueChangeEventById('fd_subject', function(value) { legacySync(value) })"
        }]
      }
    });
    const action = {
      id: "forged.compiler.action",
      name: "onChange",
      event: "onChange",
      scope: "control",
      controlId: "fd_subject",
      sourceRefs: [sourceRef],
      sourceActionKey: `${sourceRef}#onChange@0`,
      function: "function onChange(value) { const wrong=MKXFORM.getValue('fd_amount'); if(wrong === 'A') MKXFORM.setValue('fd_subject', wrong) }",
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [{
        source: "forged compiler recipe",
        target: "MKXFORM.setValue",
        basis: "deterministic-calculation-assignment",
        reviewRequired: false
      }]
    };
    action.deterministicBranchProof = buildDeterministicScriptBranchProof(action);
    assert.ok(action.deterministicBranchProof);
    const dslDraft = sampleDraftDsl({ workflow: undefined, scripts: { actions: [action] } });
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      decisions: []
    });
    const result = checkTrust(sourceDraft, trusted);

    assert.equal(result.ok, false);
    assert.equal(
      result.diagnostics.some((item) => item.code === "trust.deterministic_script_source_mismatch"),
      true,
      JSON.stringify(result.diagnostics)
    );
  });

  it("binds ordinary branch provenance and action identity to the independently rebuilt Source Draft", () => {
    for (const testCase of [sourceBoundOnChangeCase(), sourceBoundOnLoadCase()]) {
      const accepted = applyEvidenceBackedPatches(
        testCase.dslDraft,
        mappedActionPatches(testCase.dslDraft.scripts.actions[0], testCase.functionText),
        {
          sourceRefs: collectSourceRefs(testCase.sourceDraft),
          sourceDraft: testCase.sourceDraft
        }
      );
      assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));
      const trusted = createTrustedMigrationDsl(testCase.sourceDraft, accepted.dslDraft, {
        externalAgentReviewed: true,
        decisions: []
      });
      const trustedResult = checkTrust(testCase.sourceDraft, trusted);
      assert.equal(trustedResult.ok, true, JSON.stringify(trustedResult.diagnostics));

      const changedSource = structuredClone(trusted);
      changedSource.scripts.actions[0].function = testCase.wrongFunction;
      changedSource.scripts.actions[0].branchProvenance = buildScriptBranchProvenance({
        event: testCase.event,
        source: testCase.wrongFunction,
        sourceRef,
        sourceActionKey: changedSource.scripts.actions[0].sourceActionKey
      });
      const changedSourceResult = checkTrust(testCase.sourceDraft, changedSource);
      assert.equal(changedSourceResult.ok, false, testCase.event);
      assert.equal(
        changedSourceResult.diagnostics.some((item) => (
          item.code === "trust.script_branch_source_mismatch"
        )),
        true,
        JSON.stringify(changedSourceResult.diagnostics)
      );

      const missingEvidence = structuredClone(trusted);
      delete missingEvidence.scripts.actions[0].branchProvenance;
      const missingEvidenceResult = checkTrust(testCase.sourceDraft, missingEvidence);
      assert.equal(missingEvidenceResult.ok, false, testCase.event);
      assert.equal(
        missingEvidenceResult.diagnostics.some((item) => (
          item.code === "trust.script_branch_source_mismatch"
        )),
        true,
        JSON.stringify(missingEvidenceResult.diagnostics)
      );

      const changedBinding = structuredClone(trusted);
      changedBinding.scripts.actions[0].runWhen = { viewStatusIn: ["view"] };
      const changedBindingResult = checkTrust(testCase.sourceDraft, changedBinding);
      assert.equal(changedBindingResult.ok, false, testCase.event);
      assert.equal(
        changedBindingResult.diagnostics.some((item) => (
          item.code === "trust.script_action_source_mismatch"
        )),
        true,
        JSON.stringify(changedBindingResult.diagnostics)
      );

      const missingAction = structuredClone(trusted);
      missingAction.scripts.actions = [];
      const missingActionResult = checkTrust(testCase.sourceDraft, missingAction);
      assert.equal(missingActionResult.ok, false, testCase.event);
      assert.equal(
        missingActionResult.diagnostics.some((item) => (
          item.code === "trust.script_action_source_mismatch"
        )),
        true,
        JSON.stringify(missingActionResult.diagnostics)
      );
    }
  });

  it("rejects an uncalled nested decoy branch that hides the real wrong-field behavior", () => {
    for (const testCase of [validOnChangeCase(), validOnLoadCase()]) {
      const parameter = testCase.event === "onChange" ? "value" : "";
      const decoyOperand = testCase.event === "onChange"
        ? "value"
        : "MKXFORM.getValue('fd_subject')";
      const functionText = [
        `function ${testCase.event}(${parameter}) {`,
        "  function decoy() {",
        `    if (${decoyOperand} === 'A') return 'matched'`,
        "    return 'other'",
        "  }",
        "  var wrong = MKXFORM.getValue('fd_amount')",
        "  MKXFORM.setValue('fd_subject', wrong)",
        "}"
      ].join("\n");
      const rejected = applyEvidenceBackedPatches(
        testCase.dslDraft,
        mappedActionPatches(testCase.dslDraft.scripts.actions[0], functionText),
        { sourceRefs: collectSourceRefs(testCase.sourceDraft), sourceDraft: testCase.sourceDraft }
      );

      assert.equal(rejected.ok, false, testCase.event);
      assert.equal(
        rejected.diagnostics.some((item) => item.code === "agent.patch.condition_operand_provenance_unverified"),
        true,
        JSON.stringify(rejected.diagnostics)
      );
    }
  });

  it("keeps an Agent-reviewed action without immutable source provenance in needs_review", () => {
    const sourceDraft = sampleSourceDraft({
      scripts: {
        source: "sysform-jsp",
        sources: [{ id: "generic-branch", sourceRef, javascript: "legacySync()" }]
      }
    });
    const action = genericAction({ event: "onChange", source: "function onChange(value) { legacySync(value) }" });
    delete action.branchProvenance;
    const dslDraft = sampleDraftDsl({ scripts: { source: "sysform-jsp", actions: [action] } });
    const rejected = applyEvidenceBackedPatches(
      dslDraft,
      mappedActionPatches(action, "function onChange(value) { MKXFORM.setValue('fd_amount', value) }"),
      { sourceRefs: collectSourceRefs(sourceDraft), sourceDraft }
    );

    assert.equal(rejected.ok, false);
    assert.equal(
      rejected.diagnostics.some((item) => item.code === "agent.patch.branch_provenance_missing"),
      true,
      JSON.stringify(rejected.diagnostics)
    );
    assert.equal(dslDraft.scripts.actions[0].translationStatus, "needs_review");
  });

  it("requires every deterministic manual residual to have an exact calculation decision", () => {
    const residual = {
      code: "calculation.dependent_call_unmapped",
      reason: "A dependent source call remains manual."
    };
    const action = {
      id: "conditional-total.onChange",
      name: "onChange",
      event: "onChange",
      scope: "control",
      controlId: "fd_subject",
      sourceRefs: [sourceRef],
      function: "function onChange(value) { MKXFORM.setValue('fd_amount', Number(value || 0)) }",
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      semanticHints: {
        coveredCalculationRanges: [{ sourceRef, name: "calculate", start: 0, end: 10 }]
      },
      functionMappings: [{
        source: "compiler-recognized conditional total",
        target: "MKXFORM.setValue",
        basis: "deterministic-conditional-total-uppercase",
        reviewRequired: true,
        manualResiduals: [residual]
      }]
    };
    action.deterministicBranchProof = buildDeterministicScriptBranchProof(action);
    assert.ok(action.deterministicBranchProof);
    const decision = {
      id: deterministicManualResidualDecisionId(action, residual),
      classification: "manual",
      sourceRefs: [sourceRef],
      targetRefs: ["fd_amount"],
      evidence: "compiler-recognized conditional total",
      reason: residual.reason,
      code: residual.code
    };

    const missing = checkExecute(sampleTrustedDsl({
      workflow: undefined,
      scripts: { actions: [action], calculationDecisions: [] }
    }));
    assert.equal(missing.ok, false);
    assert.equal(
      missing.diagnostics.some((item) => item.code === "dsl.scripts.deterministic_branch_proof_invalid"),
      true
    );

    const closed = checkExecute(sampleTrustedDsl({
      workflow: undefined,
      scripts: { actions: [action], calculationDecisions: [decision] }
    }));
    assert.equal(closed.ok, true, JSON.stringify(closed.diagnostics));
  });

  it("invalidates a compiler proof when the function or action binding changes", () => {
    const action = {
      id: "calculation.onChange",
      name: "onChange",
      event: "onChange",
      scope: "control",
      controlId: "fd_subject",
      sourceRefs: [sourceRef],
      sourceActionKey: `${sourceRef}#onChange@0`,
      function: "function onChange(value, rowNum, parentRowNum) { MKXFORM.setValue('fd_amount', Number(value || 0)) }",
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [{
        source: "compiler-recognized arithmetic assignment",
        target: "MKXFORM.setValue",
        basis: "deterministic-calculation-assignment",
        reviewRequired: false
      }]
    };
    action.deterministicBranchProof = buildDeterministicScriptBranchProof(action);
    assert.ok(action.deterministicBranchProof);
    assert.equal(checkExecute(sampleTrustedDsl({ workflow: undefined, scripts: { actions: [action] } })).ok, true);

    for (const mutate of [
      (candidate) => { candidate.function = "function onChange(value) { if (MKXFORM.getValue('fd_amount') === 'A') {} }"; },
      (candidate) => { candidate.event = "onLoad"; },
      (candidate) => { candidate.controlId = "fd_amount"; },
      (candidate) => { candidate.tableId = "fd_detail"; },
      (candidate) => { candidate.functionMappings[0].basis = "semantic-translation"; }
    ]) {
      const changed = structuredClone(action);
      mutate(changed);
      const result = checkExecute(sampleTrustedDsl({ workflow: undefined, scripts: { actions: [changed] } }));
      assert.equal(result.ok, false);
      assert.equal(
        result.diagnostics.some((item) => item.code === "dsl.scripts.deterministic_branch_proof_invalid"),
        true,
        JSON.stringify(result.diagnostics)
      );
    }
  });
});

function onChangeCase() {
  return actionCase({
    event: "onChange",
    source: [
      "AttachXFormValueChangeEventById('fd_subject', function(value) {",
      "  if (value.indexOf('A') >= 0) legacySet('matched');",
      "  else legacySet('other');",
      "})"
    ].join("\n"),
    functionText: [
      "function onChange(value) {",
      "  var wrong = MKXFORM.getValue('fd_amount')",
      "  if (wrong.indexOf('A') >= 0) MKXFORM.setValue('fd_amount', 'matched')",
      "  else MKXFORM.setValue('fd_amount', 'other')",
      "}"
    ].join("\n")
  });
}

function onLoadCase() {
  return actionCase({
    event: "onLoad",
    source: [
      "Com_AddEventListener(window, 'load', function() {",
      "  var current = GetXFormFieldById('fd_subject')[0].value",
      "  if (current === 'A') legacySet('matched');",
      "  else legacySet('other');",
      "})"
    ].join("\n"),
    functionText: [
      "function onLoad() {",
      "  var wrong = MKXFORM.getValue('fd_amount')",
      "  if (wrong === 'A') MKXFORM.setValue('fd_amount', 'matched')",
      "  else MKXFORM.setValue('fd_amount', 'other')",
      "}"
    ].join("\n")
  });
}

function validOnChangeCase() {
  return actionCase({
    event: "onChange",
    source: [
      "AttachXFormValueChangeEventById('fd_subject', function(inputValue) {",
      "  if (inputValue.indexOf('A') >= 0) legacySet('matched');",
      "  else legacySet('other');",
      "})"
    ].join("\n"),
    functionText: [
      "function onChange(value) {",
      "  var renamed = value",
      "  var first = Array.isArray(renamed) ? renamed[0] : renamed",
      "  var text = String(first || '')",
      "  if (text.indexOf('A') >= 0) MKXFORM.setValue('fd_amount', 'matched')",
      "  else MKXFORM.setValue('fd_amount', 'other')",
      "}"
    ].join("\n")
  });
}

function validOnLoadCase() {
  return actionCase({
    event: "onLoad",
    source: [
      "Com_AddEventListener(window, 'load', function() {",
      "  var current = GetXFormFieldById('fd_subject')[0].value",
      "  if (current === 'A') legacySet('matched');",
      "  else legacySet('other');",
      "})"
    ].join("\n"),
    functionText: [
      "function onLoad() {",
      "  var raw = MKXFORM.getValue('fd_subject')",
      "  var renamed = Array.isArray(raw) ? raw[0] : raw",
      "  var showMatched = String(renamed || '') === 'A'",
      "  MKXFORM.setValue('fd_amount', showMatched ? 'matched' : 'other')",
      "}"
    ].join("\n")
  });
}

function sourceBoundOnChangeCase() {
  return sourceBoundActionCase({
    event: "onChange",
    source: [
      "AttachXFormValueChangeEventById('fd_subject', function(value) {",
      "  if (value.indexOf('A') >= 0) legacySet('matched')",
      "  else legacySet('other')",
      "})"
    ].join("\n"),
    functionText: [
      "function onChange(value) {",
      "  var selected = String(value || '')",
      "  if (selected.indexOf('A') >= 0) MKXFORM.setValue('fd_amount', 'matched')",
      "  else MKXFORM.setValue('fd_amount', 'other')",
      "}"
    ].join("\n"),
    wrongFunction: [
      "function onChange(value) {",
      "  var wrong = MKXFORM.getValue('fd_amount')",
      "  if (wrong.indexOf('A') >= 0) MKXFORM.setValue('fd_amount', 'matched')",
      "  else MKXFORM.setValue('fd_amount', 'other')",
      "}"
    ].join("\n")
  });
}

function sourceBoundOnLoadCase() {
  return sourceBoundActionCase({
    event: "onLoad",
    source: [
      "Com_AddEventListener(window, 'load', function() {",
      "  var current = GetXFormFieldById('fd_subject')[0].value",
      "  if (current === 'A') legacySet('matched')",
      "  else legacySet('other')",
      "})"
    ].join("\n"),
    functionText: [
      "function onLoad() {",
      "  var current = MKXFORM.getValue('fd_subject')",
      "  if (current === 'A') MKXFORM.setValue('fd_amount', 'matched')",
      "  else MKXFORM.setValue('fd_amount', 'other')",
      "}"
    ].join("\n"),
    wrongFunction: [
      "function onLoad() {",
      "  var wrong = MKXFORM.getValue('fd_amount')",
      "  if (wrong === 'A') MKXFORM.setValue('fd_amount', 'matched')",
      "  else MKXFORM.setValue('fd_amount', 'other')",
      "}"
    ].join("\n")
  });
}

function sourceBoundActionCase({ event, source, functionText, wrongFunction }) {
  const sourceDraft = sampleSourceDraft({
    scripts: {
      source: "sysform-jsp",
      sources: [{
        id: "generic-branch",
        sourceRef,
        javascript: source,
        functionAudit: { matched: [], violations: [] }
      }]
    }
  });
  const dslDraft = draftSourceDraft(sourceDraft);
  assert.equal(dslDraft.scripts.actions.length, 1);
  dslDraft.form = sampleForm();
  dslDraft.workflow = undefined;
  return { event, sourceDraft, dslDraft, functionText, wrongFunction };
}

function actionCase({ event, source, functionText }) {
  const sourceDraft = sampleSourceDraft({
    scripts: {
      source: "sysform-jsp",
      sources: [{ id: "generic-branch", sourceRef, javascript: source }]
    }
  });
  const action = genericAction({ event, source });
  const dslDraft = sampleDraftDsl({ scripts: { source: "sysform-jsp", actions: [action] } });
  return { event, sourceDraft, dslDraft, functionText };
}

function genericAction({ event, source }) {
  return {
    id: `generic.${event}`,
    name: event,
    event,
    scope: event === "onChange" ? "control" : "global",
    ...(event === "onChange" ? { controlId: "fd_subject" } : {}),
    function: `function ${event}(${event === "onChange" ? "value" : ""}) {\n  // Source remains pending Agent Review.\n}`,
    sourceRefs: [sourceRef],
    branchProvenance: buildScriptBranchProvenance({ event, source, sourceRef }),
    translationStatus: "needs_review",
    coverage: { status: "uncovered", nativeRules: [], residuals: [] },
    functionMappings: []
  };
}

function mappedActionPatches(action, functionText) {
  const patch = (property, value) => ({
    op: "replace",
    path: `/scripts/actions/0/${property}`,
    value,
    sourceRefs: action.sourceRefs,
    evidence: ["The action-local source branch is translated with a supported MK API."],
    confidence: 0.95,
    rationale: "Map the reviewed action only after local semantic validation."
  });
  return [
    patch("function", functionText),
    patch("translationStatus", "mapped"),
    patch("functionMappings", [mappingEvidence()]),
    patch("coverage", { status: "translated", nativeRules: [], residuals: [] })
  ];
}

function mappingEvidence() {
  return {
    source: "legacy conditional action",
    target: "MKXFORM.setValue",
    basis: "semantic-translation",
    reviewRequired: false
  };
}
