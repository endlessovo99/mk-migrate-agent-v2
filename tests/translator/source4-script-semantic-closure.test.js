import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const SOURCE4 = "tests/fixtures/source4";

function stages(sourceId) {
  const source = cleanSourceFile(`${SOURCE4}/${sourceId}`);
  return { source, draft: draftSourceDraft(source) };
}

function actionsByBasis(draft, basis) {
  return (draft.scripts?.actions || []).filter((action) =>
    action.functionMappings?.some((mapping) => mapping.basis === basis)
  );
}

describe("Source4 script semantic closure", () => {
  it("lowers unconditional attachment non-empty guards to native required fields", () => {
    const cases = [
      ["1859e7bfaa39079c5e082ab45ada2a9a", "fd_3b737ff6f7c696", true],
      ["19c9dac6eb80b3565aacdd64db6b7e34", "fd_3ef5d3dd57cdcc", true],
      ["19ed50e681ba7fdeab4e00a48dc9da44", "fd_3f536e8d4f6688", false]
    ];

    for (const [sourceId, attachmentId, fullyClosed] of cases) {
      const { source, draft } = stages(sourceId);
      const field = draft.form.fields.find((candidate) => candidate.id === attachmentId);
      const action = draft.scripts.actions.find((candidate) =>
        candidate.recipe?.kind === "attachment_non_empty" &&
        candidate.recipe.fieldId === attachmentId
      );

      assert.equal(field.props.required, true, `${sourceId}:${attachmentId}`);
      assert.equal(action?.translationStatus, "omitted", `${sourceId}:${attachmentId}`);
      assert.equal(action.function, "");
      assert.deepEqual(action.runWhen, { viewStatusIn: ["add", "edit"] });
      assert.deepEqual(action.coverage, {
        status: "covered",
        nativeRules: [],
        staticProps: [{ fieldId: attachmentId, prop: "required", value: true }],
        residuals: []
      });
      assert.equal(action.functionMappings?.[0]?.basis, "static-form-prop");
      assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
      const trusted = createTrustedMigrationDsl(source, draft, {
        externalAgentReviewed: true,
        reviewerName: "route-validation",
        checkedAt: "2026-09-01T00:00:00.000Z"
      });
      if (fullyClosed) {
        assert.equal(checkTrust(source, trusted).ok, true, JSON.stringify(checkTrust(source, trusted).diagnostics));
      }
    }
  });

  it("keeps conditional attachment guards blocked without a target attachment read API", () => {
    const { draft } = stages("19ed50e681ba7fdeab4e00a48dc9da44");
    const action = draft.scripts.actions.find((candidate) =>
      candidate.recipe?.kind === "attachment_non_empty" &&
      candidate.recipe.fieldId === "fd_3a4530a5242e44"
    );

    assert.equal(action?.translationStatus, "needs_review");
    assert.equal(action.semanticHints?.[0]?.targetApiCandidates?.length, 0);
    assert.doesNotMatch(action.function, /MKXFORM\.getValue/u);
    assert.match(action.function, /fd_3f519912b47f3e/u);
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
  });

  it("maps source-complete synchronous submit validation chains and rejects malformed source", () => {
    const completeCases = [
      ["16af8665a236a1e3c1377e641c38cd23", "fd_3a599e37116792.script.1.event.1"],
      ["1900f4bec4249fc9cde772a43b8a2e81", "fd_3d0df2cab9db08.script.1.event.1"],
      ["1900f4bec4249fc9cde772a43b8a2e81", "fd_3d0df29a686de8.script.1.event.1"],
      ["1900f4bec4249fc9cde772a43b8a2e81", "fd_3d0df01ed548a2.script.1.event.1"],
      ["1900f4bec4249fc9cde772a43b8a2e81", "fd_3d0ec28ee3916e.script.1.event.1"],
      ["190fd4c9da66e44314426f746ecb2b4e", "fd_3d35f6de1abd62.script.1.event.1"]
    ];

    for (const [sourceId, actionId] of completeCases) {
      const { draft } = stages(sourceId);
      const action = (draft.scripts?.actions || []).find((candidate) => candidate.id === actionId);
      assert.equal(action?.translationStatus, "mapped", `${sourceId}:${actionId}`);
      assert.equal(
        action.functionMappings?.[0]?.basis,
        "deterministic-synchronous-submit-validation",
        `${sourceId}:${actionId}`
      );
      assert.match(action.function, /context\.isDraft/u);
      assert.match(action.function, /MKXFORM\.toast/u);
      assert.match(action.function, /return false/u);
      assert.equal(action.deterministicBranchProof?.basis, "deterministic-synchronous-submit-validation");
      assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
    }

    const { draft: malformed } = stages("1900f4bec4249fc9cde772a43b8a2e81");
    const malformedAction = malformed.scripts.actions.find((action) =>
      action.id === "fd_3d0df213be2d04.script.1.event.1"
    );
    assert.equal(malformedAction.translationStatus, "needs_review");
  });

  it("maps mixed onLoad/onChange row effects with source-backed hidden-field assignment", () => {
    const { draft } = stages("19ed50e681ba7fdeab4e00a48dc9da44");
    const actions = draft.scripts.actions.filter((action) =>
      action.sourceRefs?.includes("source.form.jsp.fd_3f526d6e79107c.script.1") ||
      action.sourceRefs?.includes("source.form.jsp.fd_3f526d6e79107c.script.2")
    );

    assert.equal(actions.length, 3);
    assert.equal(actions.every((action) => action.translationStatus === "mapped"), true);
    assert.equal(actions.every((action) =>
      action.functionMappings?.some((mapping) =>
        mapping.basis === "deterministic-inline-radio-row-effects"
      )
    ), true);
    assert.equal(actions.some((action) =>
      action.event === "onChange" &&
      action.function.includes('MKXFORM.setValue("fd_3f526d2afe7e46", value)')
    ), true);
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
  });

  it("maps a radio choice across multi-row groups and mirrors its hidden state", () => {
    const { draft } = stages("16f7a2202ee38ad5b25e46e4905a56e4");
    const actions = draft.scripts.actions.filter((action) =>
      action.sourceRefs?.some((sourceRef) =>
        sourceRef.startsWith("source.form.jsp.fd_32836909fa859e.script.")
      )
    );

    assert.equal(actions.length, 3);
    assert.equal(actions.every((action) => action.translationStatus === "mapped"), true);
    assert.equal(actions.every((action) =>
      action.functionMappings?.some((mapping) =>
        mapping.basis === "deterministic-inline-radio-row-effects"
      )
    ), true);
    const change = actions.find((action) => action.event === "onChange");
    assert.match(change.function, /MKXFORM\.setValue\("fd_is_bg", "bg"\)/u);
    assert.match(change.function, /MKXFORM\.setValue\("fd_is_sq", "sq"\)/u);
    assert.match(change.function, /MKXFORM\.setFieldAttr\("fd_bg_row", 5\)/u);
    assert.match(change.function, /MKXFORM\.setFieldAttr\("fd_sq_row", 4\)/u);
    assert.deepEqual(change.coverage.nativeRules.sort(), [
      "linkage.fd_32836745f26bca.contains.bg",
      "linkage.fd_32836745f26bca.contains.sq"
    ]);
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
  });

  it("maps complete alert-only value-change validation and rejects an undefined diagnostic", () => {
    const { draft } = stages("1900f4bec4249fc9cde772a43b8a2e81");
    const mappedIds = [
      "fd_3d0ec2157143ea.script.1.event.1",
      "fd_3d0bacafd4153c.script.1.event.1",
      "fd_3d0ec216e41056.script.1.event.1"
    ];
    for (const actionId of mappedIds) {
      const action = draft.scripts.actions.find((candidate) => candidate.id === actionId);
      assert.equal(action?.translationStatus, "mapped", actionId);
      assert.equal(
        action.functionMappings?.[0]?.basis,
        "deterministic-synchronous-onchange-alert",
        actionId
      );
      assert.match(action.function, /MKXFORM\.toast/u);
    }
    const undefinedDiagnostic = draft.scripts.actions.find((action) =>
      action.id === "fd_3d0ba88eebbe72.script.1.event.1"
    );
    assert.equal(undefinedDiagnostic.translationStatus, "needs_review");
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
  });

  it("closes the generated calculation runtime include only with complete native-calculation evidence", () => {
    for (const sourceId of [
      "16a8b7c0fa95aab79b5377e41929cc66",
      "16a8b7ceb08e85444842a144b75ba94d",
      "172fe2c19605b509159034b4cccad56c"
    ]) {
      const { draft } = stages(sourceId);
      const nativeTargets = draft.scripts.calculationDecisions
        .filter((decision) => decision.classification === "native")
        .flatMap((decision) => decision.targetRefs)
        .sort();
      const includeActions = draft.scripts.actions.filter((action) =>
        action.functionMappings?.some((mapping) =>
          mapping.basis === "native-calculation-runtime"
        )
      );

      assert.equal(includeActions.length > 0, true, sourceId);
      for (const action of includeActions) {
        assert.equal(action.translationStatus, "omitted", `${sourceId}:${action.id}`);
        assert.deepEqual([...action.coverage.nativeCalculations].sort(), nativeTargets);
        assert.deepEqual(action.coverage.residuals, []);
      }
      assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
    }
  });

  it("maps a named legacy row-effect handler to onChange and onLoad actions", () => {
    const { draft } = stages("16af8665a236a1e3c1377e641c38cd23");
    const actions = draft.scripts.actions.filter((action) =>
      action.sourceRefs?.includes("source.form.jsp.fd_3a23f2021688de.script.1")
    );
    assert.equal(actions.length, 2);
    assert.equal(actions.every((action) => action.translationStatus === "mapped"), true);
    assert.deepEqual(actions.map((action) => action.event).sort(), ["onChange", "onLoad"]);
    for (const action of actions) {
      assert.match(action.function, /MKXFORM\.setValue\("fd_3a23fac7fec066"/u);
      assert.match(action.function, /MKXFORM\.setFieldAttr\("fd_(?:internal|external)_row"/u);
      assert.equal(
        action.functionMappings?.[0]?.basis,
        "deterministic-inline-radio-row-effects"
      );
    }
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
  });

  it("omits an exact disabled mutation only when its source control is absent", () => {
    for (const sourceId of [
      "190fd4c9da66e44314426f746ecb2b4e",
      "19a24476acdcc9ce5b708744206a2724"
    ]) {
      const { draft } = stages(sourceId);
      const action = draft.scripts.actions.find((candidate) =>
        candidate.id === "fd_3e2f07edbb7efa.script.1.event.1"
      );
      assert.equal(action.translationStatus, "omitted", sourceId);
      assert.equal(
        action.functionMappings?.[0]?.basis,
        "legacy-runtime-noop",
        sourceId
      );
      assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
    }
  });

  it("maps required-field helpers for both initial load and value changes", () => {
    const { draft } = stages("19c9dac6eb80b3565aacdd64db6b7e34");
    const actions = actionsByBasis(draft, "deterministic-required-field-toggle");
    assert.equal(actions.length, 2);
    assert.deepEqual(actions.map((action) => action.event).sort(), ["onChange", "onLoad"]);
    for (const action of actions) {
      assert.equal(action.translationStatus, "mapped");
      assert.match(action.function, /MKXFORM\.setFieldAttr\("fd_3ef5d116953d84"/u);
      assert.equal(action.deterministicBranchProof?.basis, "deterministic-required-field-toggle");
    }
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
  });

  it("lowers an exact laydate month picker to a native yyyy-MM date field", () => {
    const { source, draft } = stages("178671ba7493e3a9d35d8f740e28fd89");
    const field = draft.form.fields.find((candidate) => candidate.id === "fd_year_month");
    const action = draft.scripts.actions.find((candidate) =>
      candidate.sourceRefs?.includes("source.form.jsp.fd_36dffcc6415756.script.1")
    );

    assert.equal(field.type, "dateTime");
    assert.equal(field.componentId, "xform-datetime");
    assert.equal(field.props.dataPattern, "yyyy-MM");
    assert.equal(field.props.displayPattern, "yyyy-MM");
    assert.equal(Object.hasOwn(field.props, "hiddenLabel"), false);
    assert.equal(action.translationStatus, "omitted");
    assert.equal(action.functionMappings?.[0]?.basis, "static-form-prop");
    assert.deepEqual(action.coverage.staticProps, [
      { fieldId: "fd_year_month", prop: "dataPattern", value: "yyyy-MM" },
      { fieldId: "fd_year_month", prop: "displayPattern", value: "yyyy-MM" }
    ]);
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-09-01T00:00:00.000Z"
    });
    assert.equal(checkTrust(source, trusted).ok, true, JSON.stringify(checkTrust(source, trusted).diagnostics));

    const incompleteCoverage = structuredClone(draft);
    incompleteCoverage.scripts.actions.find((candidate) => candidate.id === action.id)
      .coverage.staticProps = action.coverage.staticProps.filter((entry) => (
        entry.prop !== "dataPattern"
      ));
    assert.equal(checkDraft(incompleteCoverage).ok, false);
  });

  it("keeps native rule action keys stable when helper definitions are injected", () => {
    const { draft } = stages("19a24476acdcc9ce5b708744206a2724");
    const sourceRef = "source.form.jsp.fd_3e95c77263ca8c.script.2";
    const rule = draft.formRules.linkage.find((candidate) =>
      candidate.source === "fd_project_property" &&
      candidate.meta?.sourceJsp === sourceRef &&
      candidate.meta?.sourceActionKey
    );
    const action = draft.scripts.actions.find((candidate) =>
      candidate.event === "onChange" &&
      candidate.controlId === "fd_project_property" &&
      candidate.sourceRefs?.includes(sourceRef)
    );

    assert.ok(rule);
    assert.ok(action);
    assert.equal(action.sourceActionKey, rule.meta.sourceActionKey);
    assert.equal(action.coverage.nativeRules.includes(rule.id), true);
  });

  it("maps radio checked-state and onclick lifecycle onto getValue/onChange", () => {
    const { source, draft } = stages("177bdce608766f2502ee0714130bb55e");
    const actions = draft.scripts.actions.filter((action) =>
      action.sourceRefs?.includes("source.form.jsp.fd_373401da7f5a7e.script.2")
    );
    const change = actions.find((action) => action.event === "onChange");
    const load = actions.find((action) => action.event === "onLoad");

    assert.equal(actions.every((action) => action.translationStatus === "mapped"), true);
    assert.equal(change?.controlId, "fd_3733f3d7ab9898");
    assert.equal(
      change.functionMappings?.[0]?.basis,
      "deterministic-radio-checked-onclick-lifecycle"
    );
    assert.match(change.function, /MKXFORM\.setValue\("fd_isout_val"/u);
    assert.match(change.function, /MKXFORM\.setFieldAttr\("fd_3733f9ed8601ce"/u);
    assert.match(load.function, /MKXFORM\.getValue\("fd_3733f3389380b0"\)/u);
    assert.match(load.function, /MKXFORM\.getValue\("fd_3733f3d7ab9898"\)/u);
    assert.doesNotMatch(change.function, /document\.|setAttribute|onclick/u);
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-09-01T00:00:00.000Z"
    });
    assert.equal(checkTrust(source, trusted).ok, true, JSON.stringify(checkTrust(source, trusted).diagnostics));
  });

  it("maps per-option radio visibility to setProps", () => {
    for (const sourceId of [
      "17c8337f9b9ff6feda7f8e24cb482a75",
      "190fd4c9da66e44314426f746ecb2b4e",
      "19a24476acdcc9ce5b708744206a2724"
    ]) {
      const { draft } = stages(sourceId);
      const action = draft.scripts.actions.find((candidate) =>
        candidate.event === "onChange" &&
        candidate.controlId === "fd_project_property" &&
        candidate.functionMappings?.some((mapping) =>
          mapping.basis === "deterministic-radio-option-visibility"
        )
      );

      assert.ok(action, sourceId);
      assert.equal(action.translationStatus, "mapped", sourceId);
      assert.match(action.function, /MKXFORM\.setProps\("fd_budget_effect"/u, sourceId);
      assert.doesNotMatch(action.function, /vkor\.eq|parent\(\)\.(?:show|hide)/u, sourceId);
      assert.equal(action.deterministicBranchProof?.basis, "deterministic-radio-option-visibility", sourceId);
      assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
    }
  });

  it("closes helper-backed project-change row, detail, and approval-branch scripts", () => {
    const { source, draft } = stages("19a24476acdcc9ce5b708744206a2724");
    const propertyChange = draft.scripts.actions.find((action) =>
      action.event === "onChange" &&
      action.controlId === "fd_project_property" &&
      action.sourceRefs?.includes("source.form.jsp.fd_3e95c77263ca8c.script.2")
    );
    const approval = draft.scripts.actions.find((action) =>
      action.controlId === "fd_Approval_branch"
    );

    assert.equal(propertyChange?.translationStatus, "mapped");
    assert.equal(
      propertyChange.functionMappings?.[0]?.basis,
      "deterministic-project-change-row-detail"
    );
    assert.match(propertyChange.function, /MKXFORM\.setValue\("fd_3e95c74ae39794"/u);
    assert.match(propertyChange.function, /MKXFORM\.setDetailFieldAttr\("\$\{table:fd_sheet\}\.fd_target_cost"/u);
    assert.match(propertyChange.function, /MKXFORM\.setFieldAttr\("fd_3e96b925d04394"/u);
    assert.doesNotMatch(propertyChange.function, /img\[title/u);
    assert.equal(approval?.translationStatus, "mapped");
    assert.match(approval.function, /MKXFORM\.toast/u);
    assert.equal(
      draft.scripts.actions.every((action) => action.translationStatus !== "needs_review"),
      true,
      JSON.stringify(draft.scripts.actions.filter((action) => action.translationStatus === "needs_review").map((action) => action.id))
    );
    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-09-01T00:00:00.000Z"
    });
    assert.equal(checkTrust(source, trusted).ok, true, JSON.stringify(checkTrust(source, trusted).diagnostics));
  });

  it("omits IE Excel import onto native detail import and drops unverified job-number hydration", () => {
    const { source, draft } = stages("184d0e88f3949b8870a0558420682dee");
    const excel = draft.scripts.actions.find((action) =>
      action.sourceRefs?.includes("source.form.jsp.fd_3607e68357f368.script.1")
    );
    const hydration = draft.scripts.actions.find((action) =>
      action.sourceRefs?.includes("source.form.jsp.fd_3343d66e1c0210.script.1")
    );

    assert.equal(excel?.translationStatus, "omitted");
    assert.equal(excel.functionMappings?.[0]?.basis, "legacy-runtime-noop");
    assert.match(excel.functionMappings[0].source, /fd_input_post|fd_update_odm/u);
    assert.equal(hydration?.translationStatus, "omitted");
    assert.equal(hydration.functionMappings?.[0]?.basis, "legacy-runtime-noop");
    assert.match(hydration.functionMappings[0].source, /fd_job_number|xform-input/u);
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-09-01T00:00:00.000Z"
    });
    assert.equal(checkTrust(source, trusted).ok, true, JSON.stringify(checkTrust(source, trusted).diagnostics));
  });

  it("omits generated SQLDialog Dialog_List runtime onto a required text field", () => {
    const { source, draft } = stages("18a8356e42d059a3140a2644792895c3");
    const field = draft.form.fields.find((candidate) => candidate.id === "fd_3c333949ed6ad4");
    const action = draft.scripts.actions.find((candidate) =>
      candidate.sourceRefs?.includes("source.form.jsp.fdDisplayJsp.script.1")
    );

    assert.equal(field.type, "text");
    assert.equal(field.props.required, true);
    assert.equal(action?.translationStatus, "omitted");
    assert.equal(action.functionMappings?.[0]?.basis, "legacy-runtime-noop");
    assert.match(action.functionMappings[0].source, /Dialog_List|SQLDialog/u);
    assert.equal(
      draft.review.warnings.some((warning) => warning.code === "source.sysform.sql_dialog_partial"),
      true
    );
    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-09-01T00:00:00.000Z"
    });
    assert.equal(checkTrust(source, trusted).ok, true, JSON.stringify(checkTrust(source, trusted).diagnostics));
  });

  it("maps detail pointer-lock and omits unbound view-mode URL rewriting", () => {
    const { source, draft } = stages("1923b93d7bcd8e63b7b743e45fba6361");
    const lock = draft.scripts.actions.find((action) =>
      action.sourceRefs?.includes("source.form.jsp.fd_3e1919245a8554.script.1")
    );
    const links = draft.scripts.actions.find((action) =>
      action.sourceRefs?.includes("source.form.jsp.fd_3ec2cf3cfd7a38.script.1")
    );

    assert.equal(lock?.translationStatus, "mapped");
    assert.match(lock.function, /MKXFORM\.disabledOperation\("\$\{table:fd_pur_pay_req\}", false\)/u);
    assert.equal(links?.translationStatus, "omitted");
    assert.equal(links.functionMappings?.[0]?.basis, "legacy-runtime-noop");
    assert.equal(
      draft.scripts.actions.every((action) => action.translationStatus !== "needs_review"),
      true
    );
    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-09-01T00:00:00.000Z"
    });
    assert.equal(checkTrust(source, trusted).ok, true, JSON.stringify(checkTrust(source, trusted).diagnostics));
  });

  it("keeps source-backed dependent option recipes review-required", () => {
    const { draft } = stages("1900f4bec4249fc9cde772a43b8a2e81");
    const actions = draft.scripts.actions.filter((candidate) =>
      candidate.recipe?.kind === "dependent_select_options"
    );

    assert.deepEqual(actions.map((action) => action.event).sort(), ["onChange", "onLoad"]);
    assert.equal(actions.every((action) => action.translationStatus === "needs_review"), true);
    assert.equal(actions.every((action) =>
      action.functionMappings?.every((mapping) => mapping.basis !== "legacy-runtime-noop")
    ), true);
  });

  it("maps a conditional hard-hidden mirror and dependent field resets", () => {
    const { draft } = stages("18809ca40ff98e01d45ec5d4923811a5");
    const action = actionsByBasis(draft, "deterministic-conditional-field-reset")[0];
    assert.equal(action?.translationStatus, "mapped");
    assert.equal(action.controlId, "fd_invoice_project");
    assert.match(action.function, /MKXFORM\.setValue\("isclbx", "2"\)/u);
    assert.match(action.function, /MKXFORM\.setValue\("fd_3bf0989304d83e", ""\)/u);
    assert.match(action.function, /MKXFORM\.setValue\("fd_project_dept", ""\)/u);
    assert.match(action.function, /MKXFORM\.setFieldAttr\("wbs_row"/u);
    assert.equal(action.deterministicBranchProof?.basis, "deterministic-conditional-field-reset");
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
  });

  it("maps nested row-state branches together with the native attachment requirement", () => {
    const { draft } = stages("1859e7bfaa39079c5e082ab45ada2a9a");
    const rowActions = draft.scripts.actions.filter((action) =>
      [
        "source.form.jsp.fd_3e74fe6f917cac.script.1",
        "source.form.jsp.fd_3e74fe6f917cac.script.2"
      ].some((sourceRef) => action.sourceRefs?.includes(sourceRef))
    );
    assert.equal(rowActions.length, 3);
    assert.equal(rowActions.every((action) => action.translationStatus === "mapped"), true);
    assert.equal(rowActions.every((action) =>
      action.functionMappings?.some((mapping) =>
        mapping.basis === "deterministic-inline-radio-row-effects"
      )
    ), true);
    const attachment = draft.scripts.actions.find((action) =>
      action.recipe?.fieldId === "fd_3b737ff6f7c696"
    );
    assert.equal(attachment.translationStatus, "omitted");
    assert.deepEqual(attachment.coverage.staticProps, [{
      fieldId: "fd_3b737ff6f7c696",
      prop: "required",
      value: true
    }]);
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
  });
});
