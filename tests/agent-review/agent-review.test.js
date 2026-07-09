import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgentReview } from "../../src/agent-review/index.js";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { OpenAIResponsesReviewProvider } from "../../src/agent-review/provider.js";
import { main } from "../../src/cli/main.js";
import { checkTrust } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sampleDraftDsl, sampleForm, sampleSourceDraft } from "../helpers/sample-dsl.js";

describe("agent-review", () => {
  it("applies valid evidence-backed patches and records audit metadata", async () => {
    const sourceDraft = sampleSourceDraft();
    const dslDraft = sampleDraftDsl();
    const provider = new FakeReviewProvider(reviewResponse({
      patches: [titlePatch("/form/fields/2/title", "IT设备明细", "source.form.detailTable.fd_detail")]
    }));

    const result = await runAgentReview(sourceDraft, dslDraft, {
      provider,
      reviewedAt: "2026-07-06T00:00:00.000Z"
    });
    const trust = checkTrust(sourceDraft, result.dsl);

    assert.equal(result.ok, true);
    assert.equal(result.dsl.artifact, "migration-dsl");
    assert.equal(result.dsl.trust.level, "trusted");
    assert.equal(result.dsl.trust.executable, true);
    assert.equal(result.dsl.form.fields[2].title, "IT设备明细");
    assert.equal(result.dsl.review.decisions.length, 1);
    assert.equal(result.dsl.review.decisions[0].targetRefs[0], "/form/fields/2/title");
    assert.equal(result.dsl.review.agentReview.provider, "openai");
    assert.equal(result.dsl.review.agentReview.baseUrl, "fake://agent-review");
    assert.equal(result.dsl.review.agentReview.model, "fake-model");
    assert.equal(result.dsl.review.agentReview.patchCount, 1);
    assert.equal(JSON.stringify(result.dsl).includes("sk-test-secret"), false);
    assert.equal(trust.ok, true);
  });

  it("exposes an agent-review CLI command that writes DSL and optional report offline through injection", async () => {
    const tempDir = cleanTempDir("cli-happy");
    const sourcePath = join(tempDir, "source-draft.json");
    const draftPath = join(tempDir, "dsl-draft.json");
    const outPath = join(tempDir, "migration.dsl.json");
    const reportPath = join(tempDir, "agent-review.report.json");
    writeJson(sourcePath, sampleSourceDraft());
    writeJson(draftPath, sampleDraftDsl());

    const restoreLog = captureConsoleLog();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    await main([
      "agent-review",
      sourcePath,
      draftPath,
      "--out",
      outPath,
      "--report-out",
      reportPath
    ], {
      agentReviewProvider: new FakeReviewProvider(reviewResponse({
        patches: [titlePatch("/form/fields/2/title", "IT设备明细", "source.form.detailTable.fd_detail")]
      })),
      reviewedAt: "2026-07-06T00:00:00.000Z"
    });
    const output = restoreLog();

    assert.equal(process.exitCode, undefined);
    process.exitCode = previousExitCode;
    assert.equal(existsSync(outPath), true);
    assert.equal(existsSync(reportPath), true);
    assert.equal(JSON.parse(readFileSync(outPath, "utf8")).artifact, "migration-dsl");
    assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).ok, true);
    assert.equal(output.includes("agent-review.complete"), true);
  });

  it("rejects workflow patches and does not produce executable DSL", async () => {
    const result = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [{
          ...titlePatch("/workflow/edges/0/condition", "should not apply", "source.workflow.edge.L1"),
          sourceRefs: ["source.workflow.edge.L1"]
        }]
      }))
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.patch-validation");
    assert.equal(result.report.diagnostics.some((item) => item.code === "agent.patch.path_disallowed"), true);
    assert.equal(result.dsl, undefined);
  });

  it("rejects illegal form paths and invalid JSON responses", async () => {
    const illegalPath = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [titlePatch("/form/layout/mkTree/0/id", "layout-change", "source.form.layout.row.row-0")]
      }))
    });
    const invalidJson = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), {
      provider: new FakeReviewProvider("{not json")
    });

    assert.equal(illegalPath.ok, false);
    assert.equal(illegalPath.report.diagnostics.some((item) => item.code === "agent.patch.path_disallowed"), true);
    assert.equal(invalidJson.ok, false);
    assert.equal(invalidJson.report.diagnostics.some((item) => item.code === "agent.response.invalid_json"), true);
  });

  it("blocks low-confidence patches without applying them", async () => {
    const result = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [{
          ...titlePatch("/form/fields/2/title", "IT设备明细", "source.form.detailTable.fd_detail"),
          confidence: 0.69
        }]
      }))
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.diagnostics.some((item) => item.code === "agent.patch.low_confidence"), true);
  });

  it("repairs invalid patch responses once and records retry history", async () => {
    const sourceDraft = sampleSourceDraft();
    const dslDraft = sampleDraftDsl();
    const provider = new FakeReviewProvider(reviewResponse({
      patches: [{
        op: "replace",
        path: "/form/fields/99/title",
        value: "IT设备明细",
        sourceRefs: ["source.form.detailTable.fd_detail"],
        evidence: [],
        confidence: 0.86,
        rationale: "The title looked placeholder-like."
      }]
    }), {
      repairRawText: reviewResponse({
        patches: [titlePatch("/form/fields/2/title", "IT设备明细", "source.form.detailTable.fd_detail")]
      })
    });

    const result = await runAgentReview(sourceDraft, dslDraft, {
      provider,
      reviewedAt: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(result.ok, true);
    assert.equal(provider.repairCalls.length, 1);
    assert.equal(provider.repairCalls[0].attempt, 1);
    assert.equal(provider.repairCalls[0].diagnostics.some((item) => item.code === "agent.patch.path_missing"), true);
    assert.equal(provider.repairCalls[0].diagnostics.some((item) => item.code === "agent.patch.evidence_required"), true);
    assert.equal(result.dsl.form.fields[2].title, "IT设备明细");
    assert.equal(result.dsl.review.agentReview.patchCount, 1);
    assert.equal(result.report.repairAttempts, 1);
    assert.equal(result.report.repairHistory.length, 1);
    assert.equal(result.report.repairHistory[0].stage, "agent-review.patch-validation");
    assert.equal(result.report.repairHistory[0].rejectedPatches[0].path, "/form/fields/99/title");
  });

  it("applies metadata-backed props patches and keeps workflow diagnostics warning-only", async () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/route-validation-lbpm");
    const dslDraft = draftSourceDraft(sourceDraft);
    dslDraft.form.fields[1].props = {};
    const result = await runAgentReview(sourceDraft, dslDraft, {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [{
          op: "replace",
          path: "/form/fields/1/props",
          value: { required: true },
          sourceRefs: ["source.form.control.fd_org"],
          evidence: ["source metadata identifies an organization control and required=true"],
          confidence: 0.91,
          rationale: "Carry metadata-backed organization props into the address component."
        }],
        diagnostics: [{
          level: "warning",
          code: "agent.workflow.condition_display_only",
          path: "/workflow/edges/1/condition",
          message: "Workflow condition remains diagnostic-only in Agent Review v1."
        }]
      }))
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.dsl.form.fields[1].props, { required: true });
    assert.equal(result.dsl.review.warnings.some((item) => item.code === "agent.workflow.condition_display_only"), true);
  });

  it("applies guarded script translation patches", async () => {
    const sourceDraft = sampleSourceDraft({
      scripts: {
        source: "sysform-jsp",
        sources: [{
          id: "fd_jsp.script.1",
          sourceRef: "source.form.jsp.fd_jsp.script.1",
          javascript: "Com_AddEventListener(window, \"load\", function(){ SetXFormFieldValueById('fd_subject', 'done') })",
          functionAudit: {
            matched: [{
              name: "SetXFormFieldValueById",
              description: "set field value",
              mkFunction: "MKXFORM.setValue('控件ID','控件值')",
              occurrences: []
            }],
            violations: []
          }
        }]
      }
    });
    const dslDraft = sampleDraftDsl({
      workflow: undefined,
      scripts: {
        source: "sysform-jsp",
        actions: [{
          id: "fd_jsp.script.1.event.1",
          name: "onLoad",
          event: "onLoad",
          scope: "global",
          function: "function onLoad() {\n  // review required\n}",
          translationStatus: "needs_review",
          sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
          coverage: { status: "uncovered", nativeRules: [], residuals: [] },
          functionMappings: []
        }]
      }
    });
    const result = await runAgentReview(sourceDraft, dslDraft, {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [
          {
            op: "replace",
            path: "/scripts/actions/0/function",
            value: "function onLoad() {\n  MKXFORM.setValue('fd_subject', 'done')\n}",
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["Source script sets fd_subject during window load."],
            confidence: 0.91,
            rationale: "SetXFormFieldValueById maps to MKXFORM.setValue in the function catalog."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/translationStatus",
            value: "mapped",
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["The translated function uses only whitelisted MKXFORM APIs."],
            confidence: 0.91,
            rationale: "No residual source behavior remains after direct value assignment translation."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/functionMappings",
            value: [{
              source: "SetXFormFieldValueById",
              target: "MKXFORM.setValue",
              basis: "function-catalog",
              reviewRequired: false
            }],
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["Function catalog maps SetXFormFieldValueById to MKXFORM.setValue."],
            confidence: 0.91,
            rationale: "Records the catalog-backed translation."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/coverage",
            value: { status: "translated", nativeRules: [], residuals: [] },
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["The MKXFORM.setValue call covers the only source value assignment."],
            confidence: 0.91,
            rationale: "No residual JSP behavior remains after translation to MK JavaScript."
          }
        ]
      })),
      reviewedAt: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(result.ok, true);
    assert.equal(result.dsl.scripts.actions[0].translationStatus, "mapped");
    assert.equal(result.dsl.scripts.actions[0].function.includes("MKXFORM.setValue"), true);
    assert.equal(result.dsl.scripts.actions[0].coverage.status, "translated");
    assert.equal(result.report.scriptTranslation.byStatus.mapped, 1);
  });

  it("rejects downgrades to protected deterministic script actions", async () => {
    const sourceDraft = sampleSourceDraft({
      scripts: {
        source: "sysform-jsp",
        sources: [{
          id: "fd_jsp.script.1",
          sourceRef: "source.form.jsp.fd_jsp.script.1",
          javascript: "SetXFormFieldValueById('fd_subject', 'done')",
          functionAudit: { matched: [], violations: [] }
        }]
      }
    });
    const dslDraft = sampleDraftDsl({
      workflow: undefined,
      scripts: {
        source: "sysform-jsp",
        actions: [{
          id: "fd_jsp.script.1.event.1",
          name: "onLoad",
          event: "onLoad",
          scope: "global",
          function: "function onLoad() {\n  MKXFORM.setValue('fd_subject', 'done')\n}",
          translationStatus: "mapped",
          sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          functionMappings: [{
            source: "window-load value assignment",
            target: "onLoad + MKXFORM.setValue",
            basis: "deterministic-pattern",
            reviewRequired: false
          }]
        }]
      }
    });
    const result = await runAgentReview(sourceDraft, dslDraft, {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [
          {
            op: "replace",
            path: "/scripts/actions/0/translationStatus",
            value: "needs_review",
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["The model was uncertain about the mapped action."],
            confidence: 0.91,
            rationale: "Downgrade instead of leaving the deterministic mapping unchanged."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/coverage",
            value: { status: "partial", nativeRules: [], residuals: ["uncertain residual"] },
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["The model was uncertain about the mapped coverage."],
            confidence: 0.91,
            rationale: "Downgrade protected coverage instead of leaving it unchanged."
          }
        ]
      }))
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.patch-validation");
    assert.equal(result.report.diagnostics.some((item) => item.code === "agent.patch.script_status_downgrade_forbidden"), true);
    assert.equal(result.report.diagnostics.some((item) => item.code === "agent.patch.script_coverage_downgrade_forbidden"), true);
  });

  it("allows native-covered script actions to be omitted with empty function text", async () => {
    const sourceDraft = sampleSourceDraft({
      scripts: {
        source: "sysform-jsp",
        sources: [{
          id: "fd_jsp.script.1",
          sourceRef: "source.form.jsp.fd_jsp.script.1",
          javascript: "AttachXFormValueChangeEventById('fd_amount', function(value){ common_dom_row_set_show_required_reset('fd_subject_row', true, true, false) })",
          functionAudit: { matched: [], violations: [] }
        }]
      }
    });
    const dslDraft = sampleDraftDsl({
      workflow: undefined,
      formRules: {
        linkage: [{
          id: "linkage.fd_amount.contains.A",
          trigger: "change",
          source: "fd_amount",
          logic: "and",
          when: [{ field: "fd_amount", op: "contains", value: "A" }],
          effects: [{ type: "visible", target: "fd_subject", value: true }],
          else: [{ type: "visible", target: "fd_subject", value: false }],
          meta: { sourceJsp: "source.form.jsp.fd_jsp.script.1" },
          translationStatus: "executable"
        }]
      },
      scripts: {
        source: "sysform-jsp",
        actions: [{
          id: "fd_jsp.script.1.event.1",
          name: "onChange",
          event: "onChange",
          scope: "control",
          controlId: "fd_amount",
          function: "function onChange(value) {\n  // review required\n}",
          translationStatus: "needs_review",
          sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
          coverage: { status: "uncovered", nativeRules: [], residuals: [] },
          functionMappings: []
        }]
      }
    });
    const result = await runAgentReview(sourceDraft, dslDraft, {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [
          {
            op: "replace",
            path: "/scripts/actions/0/function",
            value: "",
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["The matching native formRule linkage.fd_amount.contains.A covers the source visibility behavior."],
            confidence: 0.91,
            rationale: "No JavaScript is needed when the native rule covers the source behavior."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/translationStatus",
            value: "omitted",
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["The action sourceRef matches formRules.linkage meta.sourceJsp."],
            confidence: 0.91,
            rationale: "Mark the script omitted because it is native-covered."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/coverage",
            value: { status: "covered", nativeRules: ["linkage.fd_amount.contains.A"], residuals: [] },
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["The native rule has executable translationStatus and matching sourceJsp evidence."],
            confidence: 0.91,
            rationale: "Record the native rule that covers the source JSP behavior."
          }
        ]
      }))
    });

    assert.equal(result.ok, true);
    assert.equal(result.dsl.scripts.actions[0].translationStatus, "omitted");
    assert.equal(result.dsl.scripts.actions[0].function, "");
    assert.equal(result.dsl.scripts.actions[0].coverage.status, "covered");
  });

  it("closes already native-covered JSP actions even when source contains DOM helper noise", async () => {
    const sourceDraft = sampleSourceDraft({
      scripts: {
        source: "sysform-jsp",
        sources: [{
          id: "fd_jsp.script.1",
          sourceRef: "source.form.jsp.fd_jsp.script.1",
          javascript: "AttachXFormValueChangeEventById('fd_amount', function(value){ setITTableValidate(); common_dom_row_set_show_required_reset('fd_subject_row', true, true, false); document.getElementsByTagName('img')[0].setAttribute('onclick','x') })",
          functionAudit: { matched: [], violations: [] }
        }]
      }
    });
    const dslDraft = sampleDraftDsl({
      workflow: undefined,
      formRules: {
        linkage: [{
          id: "linkage.fd_amount.contains.A",
          trigger: "change",
          source: "fd_amount",
          logic: "and",
          when: [{ field: "fd_amount", op: "contains", value: "A" }],
          effects: [{ type: "visible", target: "fd_subject", value: true }],
          else: [{ type: "visible", target: "fd_subject", value: false }],
          meta: { sourceJsp: "source.form.jsp.fd_jsp.script.1" },
          translationStatus: "executable"
        }]
      },
      scripts: {
        source: "sysform-jsp",
        actions: [{
          id: "fd_jsp.script.1.event.1",
          name: "onChange",
          event: "onChange",
          scope: "control",
          controlId: "fd_amount",
          function: "function onChange(value) {\n  // Source JSP JavaScript:\n  // AttachXFormValueChangeEventById('fd_amount', function(value){ setITTableValidate(); common_dom_row_set_show_required_reset('fd_subject_row', true, true, false); document.getElementsByTagName('img')[0].setAttribute('onclick','x') })\n}",
          translationStatus: "needs_review",
          sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
          coverage: { status: "covered", nativeRules: ["linkage.fd_amount.contains.A"], residuals: [] },
          functionMappings: []
        }]
      }
    });
    const prompt = buildAgentReviewPrompt(sourceDraft, dslDraft);
    const actionSummary = prompt.context.dslDraft.scripts.actions[0];

    assert.equal(prompt.system.includes("Native-covered closure rule"), true);
    assert.equal(actionSummary.reviewOpportunities[0].kind, "native_coverage_candidate");
    assert.equal(actionSummary.reviewOpportunities[0].requiredDecision.includes("Patch this action to omitted"), true);

    const result = await runAgentReview(sourceDraft, dslDraft, {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [
          {
            op: "replace",
            path: "/scripts/actions/0/function",
            value: "",
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["The draft action already has coverage.status=covered with nativeRules and empty residuals."],
            confidence: 0.91,
            rationale: "Close native-covered JSP row visibility/required behavior as omitted."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/translationStatus",
            value: "omitted",
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["Native formRules linkage covers the row visibility/required behavior."],
            confidence: 0.91,
            rationale: "No JavaScript should run for native-covered behavior."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/functionMappings",
            value: [{
              source: "legacy JSP row visibility/required behavior",
              target: "native formRules.linkage",
              basis: "native-form-rule",
              reviewRequired: false
            }],
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["The existing nativeRules list provides native formRules linkage evidence."],
            confidence: 0.91,
            rationale: "Record native-form-rule closure."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/coverage",
            value: { status: "covered", nativeRules: ["linkage.fd_amount.contains.A"], residuals: [] },
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["Preserve covered coverage and original nativeRules with residuals empty."],
            confidence: 0.91,
            rationale: "Do not invent residuals from DOM/helper noise for already-covered actions."
          }
        ]
      }))
    });

    assert.equal(result.ok, true);
    assert.equal(result.dsl.scripts.actions[0].translationStatus, "omitted");
    assert.equal(result.dsl.scripts.actions[0].function, "");
    assert.equal(result.dsl.scripts.actions[0].functionMappings[0].basis, "native-form-rule");
    assert.deepEqual(result.dsl.scripts.actions[0].coverage.nativeRules, ["linkage.fd_amount.contains.A"]);
  });

  it("accepts semantic detail-row visibility patches without treating onclick binding as residual", async () => {
    const form = sampleForm();
    form.fields[2].columns.push(
      {
        id: "fd_choice",
        title: "请购类型",
        type: "singleSelect",
        componentId: "xform-select",
        props: {},
        sourceProps: { designerType: "select" },
        sourceRef: "source.form.detailTable.fd_detail.column.fd_choice"
      },
      {
        id: "fd_replacement_asset",
        title: "请填写更换资产编号",
        type: "text",
        componentId: "xform-input",
        props: {},
        sourceProps: { designerType: "inputText" },
        sourceRef: "source.form.detailTable.fd_detail.column.fd_replacement_asset"
      },
      {
        id: "fd_isout_val",
        title: "隐藏更换标记",
        type: "text",
        componentId: "xform-input",
        props: {},
        sourceProps: { designerType: "inputText" },
        sourceRef: "source.form.detailTable.fd_detail.column.fd_isout_val"
      }
    );
    const sourceDraft = sampleSourceDraft({
      form: {
        detailTables: [{
          id: "fd_detail",
          sourceRef: "source.form.detailTable.fd_detail",
          columns: [
            { id: "fd_name", sourceRef: "source.form.detailTable.fd_detail.column.fd_name" },
            { id: "fd_choice", sourceRef: "source.form.detailTable.fd_detail.column.fd_choice" },
            { id: "fd_replacement_asset", sourceRef: "source.form.detailTable.fd_detail.column.fd_replacement_asset" },
            { id: "fd_isout_val", sourceRef: "source.form.detailTable.fd_detail.column.fd_isout_val" }
          ]
        }],
        layout: {
          rows: [
            {
              id: "row-0",
              sourceRef: "source.form.layout.row.row-0",
              cells: [
                { id: "row-0-cell-0", sourceRef: "source.form.layout.cell.row-0-cell-0" },
                { id: "row-0-cell-1", sourceRef: "source.form.layout.cell.row-0-cell-1" }
              ]
            },
            { id: "row-1", sourceRef: "source.form.layout.row.row-1", cells: [{ id: "row-1-cell-0", sourceRef: "source.form.layout.cell.row-1-cell-0" }] }
          ]
        }
      },
      scripts: {
        source: "sysform-jsp",
        sources: [{
          id: "fd_jsp.script.1",
          sourceRef: "source.form.jsp.fd_jsp.script.1",
          javascript: "function controlDisplay(value,i){ var hidden=document.getElementsByName('extendDataFormInfo.value(fd_detail.'+i+'.fd_isout_val)')[0]; if(value=='gh'){ hidden.value='true'; document.getElementsByName('extendDataFormInfo.value(fd_detail.'+i+'.fd_replacement_asset)')[0].style.display=''; document.getElementsByName('extendDataFormInfo.value(fd_detail.'+i+'.fd_replacement_asset)')[0].setAttribute('validate','required'); } else { hidden.value=''; document.getElementsByName('extendDataFormInfo.value(fd_detail.'+i+'.fd_replacement_asset)')[0].style.display='none'; document.getElementsByName('extendDataFormInfo.value(fd_detail.'+i+'.fd_replacement_asset)')[0].setAttribute('validate',''); } } var xg=document.getElementsByName('extendDataFormInfo.value(fd_detail.'+i+'.fd_choice)')[0]; xg.setAttribute('onclick','__xformDispatch(this.value);controlDisplay(this.value,'+i+')');",
          functionAudit: { matched: [], violations: [] }
        }]
      }
    });
    const dslDraft = sampleDraftDsl({
      workflow: undefined,
      form,
      scripts: {
        source: "sysform-jsp",
        actions: [{
          id: "fd_jsp.script.1.event.1",
          name: "onChange",
          event: "onChange",
          scope: "control",
          tableId: "fd_detail",
          controlId: "fd_choice",
          function: "function onChange(value, rowNum, parentRowNum) {\n  // Source JSP JavaScript:\n  // function controlDisplay(value,i){ hidden.value='true'; style.display=''; setAttribute('validate','required'); }\n  // xg.setAttribute('onclick','__xformDispatch(this.value);controlDisplay(this.value,'+i+')');\n}",
          translationStatus: "needs_review",
          sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
          coverage: { status: "none", nativeRules: [], residuals: [] },
          functionMappings: [],
          semanticHints: [{
            kind: "detail_row_visibility",
            triggerTableId: "fd_detail",
            triggerControlId: "fd_choice",
            targetControlId: "fd_replacement_asset",
            hiddenControlId: "fd_isout_val",
            targetApiCandidates: ["MKXFORM.updateControl", "MKXFORM.updateControlStyle", "MKXFORM.setDetailFieldItemAttr"],
            evidence: "Legacy action-local controlDisplay writes hidden state, display, and required state."
          }]
        }]
      }
    });
    const prompt = buildAgentReviewPrompt(sourceDraft, dslDraft);
    const opportunity = prompt.context.dslDraft.scripts.actions[0].reviewOpportunities[0];

    assert.equal(prompt.system.includes("legacy onclick/setAttribute/__xformDispatch snippets are event-binding scaffolding"), true);
    assert.equal(opportunity.eventScaffoldingPolicy.includes("DSL action already preserves event=onChange"), true);
    assert.equal(opportunity.targetApis.includes("MKXFORM.setDetailFieldItemAttr"), true);

    const result = await runAgentReview(sourceDraft, dslDraft, {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [
          {
            op: "replace",
            path: "/scripts/actions/0/function",
            value: "function onChange(value, rowNum, parentRowNum) {\n  var selectedValue = Array.isArray(value) ? value[0] : value\n  var isReplacement = selectedValue === 'gh'\n  var targetField = '${table:fd_detail}.fd_replacement_asset'\n  var hiddenField = '${table:fd_detail}.fd_isout_val'\n  MKXFORM.updateControl(hiddenField, rowNum, isReplacement ? 'true' : '')\n  MKXFORM.updateControlStyle(targetField, rowNum, { display: isReplacement ? 'block' : 'none' })\n  MKXFORM.setDetailFieldItemAttr(targetField, rowNum, isReplacement ? 3 : 6)\n}",
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["Action-local controlDisplay writes hidden state, display, and validate=required for the same detail row."],
            confidence: 0.91,
            rationale: "Legacy onclick binding is event scaffolding because the DSL action already preserves onChange table/control boundary."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/translationStatus",
            value: "mapped",
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["The translated function uses only targetApi calls and preserves rowNum."],
            confidence: 0.91,
            rationale: "TargetApi covers the action-local hidden value, display, and required semantics."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/functionMappings",
            value: [{
              source: "detail-row DOM hidden value/display/required behavior",
              target: "MKXFORM.updateControl + MKXFORM.updateControlStyle + MKXFORM.setDetailFieldItemAttr",
              basis: "semantic-translation",
              reviewRequired: false
            }],
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["targetApi catalog allows updateControl, updateControlStyle, and setDetailFieldItemAttr."],
            confidence: 0.91,
            rationale: "Record semantic targetApi mapping."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/coverage",
            value: { status: "translated", nativeRules: [], residuals: [] },
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["No residual business behavior remains after excluding legacy event-binding scaffolding."],
            confidence: 0.91,
            rationale: "The translated function covers action-local business behavior."
          }
        ]
      }))
    });

    assert.equal(result.ok, true);
    assert.equal(result.dsl.scripts.actions[0].translationStatus, "mapped");
    assert.equal(result.dsl.scripts.actions[0].function.includes("MKXFORM.setDetailFieldItemAttr"), true);
    assert.equal(result.dsl.scripts.actions[0].coverage.status, "translated");
  });

  it("blocks error diagnostics from the model before trusted output", async () => {
    const result = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [],
        diagnostics: [{
          level: "error",
          code: "agent.workflow.needs_human_review",
          path: "/workflow/edges/0/condition",
          message: "Workflow condition cannot be reviewed safely."
        }]
      }))
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.diagnostics");
    assert.equal(result.report.diagnostics.some((item) => item.code === "agent.workflow.needs_human_review"), true);
  });

  it("fails closed on missing OpenAI env without calling fetch", async () => {
    let fetchCalled = false;
    const provider = new OpenAIResponsesReviewProvider({
      env: {},
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("should not call network");
      }
    });
    const result = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), { provider });

    assert.equal(result.ok, false);
    assert.equal(fetchCalled, false);
    assert.equal(result.report.stage, "agent-review.env");
    assert.equal(result.report.diagnostics.some((item) => item.code === "agent.provider.env_missing"), true);
  });

  it("does not leak OPENAI_API_KEY into reports when provider errors include it", async () => {
    const secret = "sk-test-secret";
    const provider = new OpenAIResponsesReviewProvider({
      env: {
        OPENAI_BASE_URL: "https://example.test",
        OPENAI_API_KEY: secret,
        OPENAI_MODEL: "fake-model"
      },
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        text: async () => `upstream echoed ${secret}`
      })
    });
    const result = await runAgentReview(sampleSourceDraft(), sampleDraftDsl(), { provider });

    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result.report).includes(secret), false);
    assert.equal(JSON.stringify(result.report).includes("https://example.test"), true);
  });

  it("keeps ordinary translate deterministic and provider-free", async () => {
    const tempDir = cleanTempDir("translate");
    const outPath = join(tempDir, "dsl-draft.json");
    const provider = new FakeReviewProvider(reviewResponse({ patches: [] }));
    const restoreLog = captureConsoleLog();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    await main([
      "translate",
      "tests/fixtures/source/route-validation-lbpm",
      "--out",
      outPath
    ], {
      agentReviewProvider: provider
    });
    restoreLog();

    assert.equal(process.exitCode, undefined);
    process.exitCode = previousExitCode;
    assert.equal(provider.called, false);
    assert.equal(JSON.parse(readFileSync(outPath, "utf8")).artifact, "dsl-draft");
  });

  it("builds prompt context from structured source facts without raw XML", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/19bb55286bd93a6081a33e44c3791374");
    const dslDraft = draftSourceDraft(sourceDraft);
    const prompt = buildAgentReviewPrompt(sourceDraft, dslDraft);
    const text = JSON.stringify(prompt);

    assert.equal(text.includes("_SysFormTemplate.xml"), false);
    assert.equal(text.includes("<xform"), false);
    assert.equal(text.includes("itTable"), true);
    assert.equal(text.includes("/workflow"), true);
    assert.equal(text.includes("/form/fields/*/columns/*/props"), true);
    assert.equal(prompt.context.patchTargetSummary.fieldCount > 0, true);
    assert.match(prompt.context.patchTargetSummary.validFieldIndexRange, /^0\.\.\d+$/);
    assert.equal(prompt.context.allowedConcretePatchPaths.includes("/form/fields/0/title"), true);
    assert.equal(prompt.context.allowedConcretePatchPaths.some((path) => /\/columns\/0\/title$/.test(path)), true);
    assert.equal(prompt.context.allowedConcretePatchPaths.some((path) => /^\/scripts\/actions\/0\/function$/.test(path)), true);
    assert.equal(prompt.system.includes("Non-whitelisted EKP functions are not automatically blocking"), true);
    assert.equal(prompt.context.scriptTranslationPolicy.nonWhitelistedFunctions.defaultHandling, "attempt_semantic_translation");
    assert.equal(prompt.context.scriptTranslationPolicy.nonWhitelistedFunctions.blockingByDefault, false);
    assert.equal(prompt.system.includes("formRules.linkage"), true);
    assert.equal(prompt.context.dslDraft.formRules.linkageCount > 0, true);
    assert.equal(prompt.system.includes("Pattern matching is evidence extraction only"), true);
    assert.equal(prompt.context.jspTranslationPlaybook.id, "jsp-translation-playbook");
    assert.equal(prompt.context.jspTranslationPlaybook.fewShotExamples.some((example) => example.id === "row-load-guarded-by-value"), true);
    assert.equal(prompt.context.scriptTranslationPolicy.commonDomRowPattern, undefined);
    assert.equal(prompt.context.sourceDraft.scripts.sources.some((source) => source.semanticFacts?.rowMarkers?.length), true);
  });
});

class FakeReviewProvider {
  constructor(rawText, options = {}) {
    this.rawText = rawText;
    this.called = false;
    this.repairCalls = [];
    if (options.repairRawText !== undefined) {
      this.repairReviewResponse = async (input) => {
        this.repairCalls.push(input);
        return {
          ok: true,
          status: "received",
          stage: "agent-review.provider-repair",
          provider: "openai",
          baseUrl: "fake://agent-review",
          model: "fake-model",
          promptVersion: "test-prompt",
          rawText: options.repairRawText,
          rawResponsePreview: options.repairRawText.slice(0, 2000)
        };
      };
    }
  }

  metadata() {
    return {
      provider: "openai",
      baseUrl: "fake://agent-review",
      model: "fake-model"
    };
  }

  async review() {
    this.called = true;
    return {
      ok: true,
      status: "received",
      stage: "agent-review.provider",
      provider: "openai",
      baseUrl: "fake://agent-review",
      model: "fake-model",
      promptVersion: "test-prompt",
      rawText: this.rawText,
      rawResponsePreview: this.rawText.slice(0, 2000)
    };
  }
}

function reviewResponse(overrides = {}) {
  return JSON.stringify({
    summary: "Reviewed form DSL and proposed semantic repairs.",
    patches: overrides.patches || [],
    diagnostics: overrides.diagnostics || []
  });
}

function titlePatch(path, value, sourceRef) {
  return {
    op: "replace",
    path,
    value,
    sourceRefs: [sourceRef],
    evidence: ["source fields and columns provide matching business semantics"],
    confidence: 0.86,
    rationale: "The draft title is placeholder-like and source evidence supports the replacement."
  };
}

function cleanTempDir(name) {
  const path = join(".tmp", "agent-review-tests", name);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function captureConsoleLog() {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  return () => {
    console.log = original;
    return lines.join("\n");
  };
}
