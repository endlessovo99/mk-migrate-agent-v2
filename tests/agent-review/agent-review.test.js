import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgentReview } from "../../src/agent-review/index.js";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { OpenAIResponsesReviewProvider } from "../../src/agent-review/provider.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { main } from "../../src/cli/main.js";
import { buildScriptBranchProvenance } from "../../src/dsl/script-branch-provenance.js";
import { checkTrust } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { localCorpusIt } from "../helpers/local-corpus.js";
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
      reviewerName: "codex-test-reviewer",
      reviewedAt: "2026-07-06T00:00:00.000Z"
    });
    const trust = checkTrust(sourceDraft, result.dsl);

    assert.equal(result.ok, true, JSON.stringify(result.report?.diagnostics || result.diagnostics));
    assert.equal(result.dsl.artifact, "migration-dsl");
    assert.equal(result.dsl.trust.level, "trusted");
    assert.equal(result.dsl.trust.executable, true);
    assert.equal(result.dsl.trust.reviewer.name, "codex-test-reviewer");
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

  it("blocks workflow formula evidence forgery and node removal before calling the provider", async () => {
    const sourceExpression = "import java.util.List; return handlers;";
    const sourceDraft = sampleSourceDraft();
    sourceDraft.workflow.nodes[1].attributes = {
      handlerSelectType: "formula",
      handlerIds: sourceExpression,
      handlerNames: "复杂公式"
    };
    sourceDraft.workflow.nodes.push({
      id: "N3",
      sourceRef: "source.workflow.node.N3",
      attributes: { handlerSelectType: "formula", handlerIds: "$docCreator$", handlerNames: "$docCreator$" }
    });

    for (const attack of ["attributes", "identity", "deletion"]) {
      const provider = new FakeReviewProvider(reviewResponse());
      const dslDraft = sampleDraftDsl();
      if (attack === "deletion") {
        dslDraft.workflow.nodes.splice(1, 1);
      } else {
        dslDraft.workflow.nodes[1] = {
          id: "N2",
          type: "review",
          element: "manualTask",
          sourceRef: attack === "identity" ? "source.workflow.node.N3" : "source.workflow.node.N2",
          attributes: {
            handlerSelectType: "formula",
            handlerIds: "$docCreator$",
            handlerNames: "$docCreator$"
          },
          participants: {
            mode: "doc_creator",
            sourceExpression: "$docCreator$",
            sourceNameExpression: "$docCreator$"
          },
          translationStatus: "executable"
        };
      }

      const result = await runAgentReview(sourceDraft, dslDraft, { provider });

      assert.equal(result.ok, false, attack);
      assert.equal(result.report.stage, "agent-review.input", attack);
      assert.equal(provider.called, false, attack);
      assert.equal(
        result.report.diagnostics.some((item) => item.code === "agent.input.workflow_formula_unrepairable"),
        true,
        attack
      );
    }
  });

  it("blocks a mapped formula participant added to a non-formula source node", async () => {
    const provider = new FakeReviewProvider(reviewResponse());
    const dslDraft = sampleDraftDsl();
    dslDraft.workflow.nodes[1].participants = {
      mode: "doc_creator",
      sourceExpression: "$docCreator$",
      sourceNameExpression: "$docCreator$"
    };

    const result = await runAgentReview(sampleSourceDraft(), dslDraft, { provider });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.input");
    assert.equal(provider.called, false);
    assert.equal(
      result.report.diagnostics.some((item) => item.code === "agent.input.workflow_formula_provenance_mismatch"),
      true
    );
  });

  it("blocks target field and originalId substitution before calling the provider", async () => {
    const provider = new FakeReviewProvider(reviewResponse());
    const formula = "$组织架构.根据登录名取用户$($fd_subject$)";
    const sourceDraft = sampleSourceDraft();
    sourceDraft.workflow.nodes[1].attributes = {
      handlerSelectType: "formula",
      handlerIds: formula,
      handlerNames: "$组织架构.根据登录名取用户$($主题$)"
    };
    const dslDraft = sampleDraftDsl();
    const wrongTarget = dslDraft.form.fields.find((field) => field.id === "fd_amount");
    const authoritativeTarget = dslDraft.form.fields.find((field) => field.id === "fd_subject");
    wrongTarget.sourceProps.originalId = "fd_subject";
    wrongTarget.sourceRef = authoritativeTarget.sourceRef;
    dslDraft.workflow.nodes[1] = {
      ...dslDraft.workflow.nodes[1],
      type: "review",
      element: "manualTask",
      attributes: sourceDraft.workflow.nodes[1].attributes,
      participants: {
        mode: "person_by_login_name",
        fieldId: "fd_amount",
        sourceFieldId: "fd_subject",
        fieldTitle: "主题",
        sourceExpression: formula,
        sourceNameExpression: "$组织架构.根据登录名取用户$($主题$)"
      }
    };

    const result = await runAgentReview(sourceDraft, dslDraft, { provider });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.input");
    assert.equal(provider.called, false);
    assert.equal(
      result.report.diagnostics.some((item) => item.code === "agent.input.workflow_formula_provenance_mismatch"),
      true
    );
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

  it("rejects script patches that use setFieldAttr on ${table:...} or detail-table ids", async () => {
    const form = sampleForm();
    form.layout.mkTree[1] = {
      ...form.layout.mkTree[1],
      sourceMarkers: ["fd_detail_row"]
    };
    const sourceDraft = sampleSourceDraft({
      workflow: undefined,
      scripts: {
        source: "sysform-jsp",
        sources: [{
          id: "fd_jsp.script.1",
          sourceRef: "source.form.jsp.fd_jsp.script.1",
          javascript: "AttachXFormValueChangeEventById('fd_subject', function(value){ common_dom_row_set_show_required_reset(\"fd_detail_row\", true, true, false); })",
          functionAudit: { matched: [], violations: [] }
        }]
      }
    });
    const sourceAction = onlyDraftedScriptAction(sourceDraft);
    const dslDraft = sampleDraftDsl({
      form,
      workflow: undefined,
      scripts: {
        source: "sysform-jsp",
        actions: [{
          ...sourceAction,
          function: "function onChange(value) {\n  // Source JSP JavaScript:\n  // common_dom_row_set_show_required_reset(\"fd_detail_row\", true, true, false);\n}",
          translationStatus: "needs_review",
          coverage: { status: "none", nativeRules: [], residuals: [] },
          functionMappings: []
        }]
      }
    });

    const rejected = await runAgentReview(sourceDraft, dslDraft, {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [{
          op: "replace",
          path: "/scripts/actions/0/function",
          value: "function onChange(value) {\n  MKXFORM.setFieldAttr(\"${table:fd_detail}\", value ? 5 : 4)\n}",
          sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
          evidence: ["Legacy row toggle incorrectly mapped to a detail-table placeholder."],
          confidence: 0.91,
          rationale: "Should be rejected by setFieldAttr target validation."
        }]
      }))
    });

    const accepted = await runAgentReview(sourceDraft, dslDraft, {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [
          {
            op: "replace",
            path: "/scripts/actions/0/function",
            value: "function onChange(value) {\n  MKXFORM.setFieldAttr(\"fd_detail_row\", 5)\n  MKXFORM.setFieldAttr(\"fd_detail_row\", 3)\n}",
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["Legacy common_dom_row_set_show_required_reset targets fd_detail_row."],
            confidence: 0.91,
            rationale: "Use the layout sourceMarker for whole-row visibility."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/translationStatus",
            value: "mapped",
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["Mapped with setFieldAttr on the sourceMarker."],
            confidence: 0.91,
            rationale: "Target resolves through layout sourceMarkers."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/functionMappings",
            value: [{
              source: "common_dom_row_set_show_required_reset",
              target: "MKXFORM.setFieldAttr",
              basis: "semantic-translation",
              reviewRequired: false
            }],
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["Playbook maps row markers to setFieldAttr."],
            confidence: 0.91,
            rationale: "Record semantic mapping."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/coverage",
            value: { status: "translated", nativeRules: [], residuals: [] },
            sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
            evidence: ["Row marker visibility is fully represented."],
            confidence: 0.91,
            rationale: "Close as translated."
          }
        ]
      }))
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.report.diagnostics.some((item) => item.code === "agent.patch.set_field_attr_target_invalid"), true);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.dsl.scripts.actions[0].function.includes("fd_detail_row"), true);
    assert.equal(accepted.dsl.scripts.actions[0].function.includes("${table:"), false);
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

    assert.equal(result.ok, true, JSON.stringify(result.report?.diagnostics || result.diagnostics));
    assert.equal(provider.repairCalls.length, 1);
    assert.equal(provider.repairCalls[0].attempt, 1);
    assert.equal(provider.repairCalls[0].diagnostics.some((item) => item.code === "agent.patch.path_missing"), true);
    assert.equal(provider.repairCalls[0].diagnostics.some((item) => item.code === "agent.patch.evidence_required"), true);
    assert.equal(result.dsl.form.fields[2].title, "IT设备明细");
    assert.equal(result.dsl.review.agentReview.patchCount, 1);
    assert.equal(result.report.repairAttempts, 1);
    assert.equal(result.report.repairHistory.length, 1);
    assert.equal(result.report.repairHistory[0].stage, "agent-review.patch-validation");
    assert.equal(result.report.repairHistory[0].batchOrdinal, 1);
    assert.deepEqual(result.report.repairHistory[0].reviewScope, {
      actionIndexes: [],
      actionIds: [],
      includeFormTargets: true
    });
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
      workflow: undefined,
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
    const sourceAction = onlyDraftedScriptAction(sourceDraft);
    const dslDraft = sampleDraftDsl({
      workflow: undefined,
      scripts: {
        source: "sysform-jsp",
        actions: [{
          ...sourceAction,
          function: "function onLoad() {\n  // review required\n}",
          translationStatus: "needs_review",
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
    const sourceRef = "source.form.jsp.fd_jsp.script.1";
    const sourceActionKey = `${sourceRef}#onChange@0`;
    const nativeRule = {
      id: "linkage.fd_amount.contains.A",
      trigger: "change",
      source: "fd_amount",
      logic: "and",
      when: [{ field: "fd_amount", op: "contains", value: "A" }],
      effects: [
        { type: "visible", target: "fd_subject_row", value: true },
        { type: "required", target: "fd_subject_row", value: true }
      ],
      else: [
        { type: "visible", target: "fd_subject_row", value: false },
        { type: "required", target: "fd_subject_row", value: false }
      ],
      meta: { sourceJsp: sourceRef, sourceActionKey },
      translationStatus: "executable"
    };
    const sourceDraft = sampleSourceDraft({
      workflow: undefined,
      formRules: { linkage: [nativeRule] },
      scripts: {
        source: "sysform-jsp",
        sources: [{
          id: "fd_jsp.script.1",
          sourceRef,
          javascript: "AttachXFormValueChangeEventById('fd_amount', function(value){ if (value.indexOf('A') >= 0) { common_dom_row_set_show_required_reset('fd_subject_row', true, true, false); } else { common_dom_row_set_show_required_reset('fd_subject_row', false, false, false); } })",
          functionAudit: { matched: [], violations: [] }
        }]
      }
    });
    sourceDraft.form.layout.rows[0].sourceMarkers = ["fd_subject_row"];
    const sourceAction = onlyDraftedScriptAction(sourceDraft);
    const form = sampleForm();
    form.layout.mkTree[0].sourceMarkers = ["fd_subject_row"];
    const dslDraft = sampleDraftDsl({
      form,
      workflow: undefined,
      formRules: { linkage: [nativeRule] },
      scripts: {
        source: "sysform-jsp",
        actions: [{
          ...sourceAction,
          function: "function onChange(value) {\n  // review required\n}",
          translationStatus: "needs_review",
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

    assert.equal(result.ok, true, JSON.stringify(result.report?.diagnostics || result.diagnostics));
    assert.equal(result.dsl.scripts.actions[0].translationStatus, "omitted");
    assert.equal(result.dsl.scripts.actions[0].function, "");
    assert.equal(result.dsl.scripts.actions[0].coverage.status, "covered");
  });

  it("rejects gated form rules as Agent Review native coverage", () => {
    const sourceRef = "source.form.jsp.fd_jsp.script.gated";
    const ruleId = "linkage.fd_amount.contains.A";
    const dslDraft = sampleDraftDsl({
      workflow: undefined,
      formRules: {
        linkage: [{
          id: ruleId,
          trigger: "change",
          source: "fd_amount",
          logic: "and",
          when: [{ field: "fd_amount", op: "contains", value: "A" }],
          effects: [{ type: "visible", target: "fd_subject", value: true }],
          else: [{ type: "visible", target: "fd_subject", value: false }],
          meta: {
            sourceJsp: sourceRef,
            runWhen: { viewStatusIn: ["add", "edit"] }
          },
          translationStatus: "executable"
        }]
      },
      scripts: {
        source: "sysform-jsp",
        actions: [{
          id: "fd_jsp.script.gated.event.1",
          name: "onChange",
          event: "onChange",
          scope: "control",
          controlId: "fd_amount",
          function: "function onChange(value) { /* review */ }",
          translationStatus: "needs_review",
          sourceRefs: [sourceRef],
          coverage: { status: "uncovered", nativeRules: [], residuals: [] },
          functionMappings: [],
          runWhen: { viewStatusIn: ["add", "edit"] }
        }]
      }
    });
    const result = applyEvidenceBackedPatches(dslDraft, [{
      op: "replace",
      path: "/scripts/actions/0/coverage",
      value: { status: "covered", nativeRules: [ruleId], residuals: [] },
      sourceRefs: [sourceRef],
      evidence: ["The rule has matching control and source evidence but carries an unpersistable gate."],
      confidence: 0.91,
      rationale: "Attempt to reuse a gated form rule as native coverage."
    }], { sourceRefs: new Set([sourceRef]) });

    assert.equal(result.ok, false);
    assert.equal(
      result.diagnostics.some((item) => item.code === "agent.patch.native_rule_action_mismatch"),
      true
    );
  });

  it("rejects native rule coverage attached to a different action event", async () => {
    const sourceRef = "source.form.jsp.fd_jsp.script.1";
    const sourceDraft = sampleSourceDraft({
      scripts: {
        source: "sysform-jsp",
        sources: [{
          id: "fd_jsp.script.1",
          sourceRef,
          javascript: "Com_AddEventListener(window, 'load', function(){ /* review */ })",
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
          meta: { sourceJsp: sourceRef },
          translationStatus: "executable"
        }]
      },
      scripts: {
        source: "sysform-jsp",
        actions: [{
          id: "fd_jsp.script.1.event.1",
          name: "onLoad",
          event: "onLoad",
          scope: "global",
          function: "function onLoad() { /* review */ }",
          translationStatus: "needs_review",
          sourceRefs: [sourceRef],
          coverage: { status: "uncovered", nativeRules: [], residuals: [] },
          functionMappings: []
        }]
      }
    });
    const result = await runAgentReview(sourceDraft, dslDraft, {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [{
          op: "replace",
          path: "/scripts/actions/0/coverage",
          value: { status: "covered", nativeRules: ["linkage.fd_amount.contains.A"], residuals: [] },
          sourceRefs: [sourceRef],
          evidence: ["The rule and action occur in the same JSP source."],
          confidence: 0.91,
          rationale: "Incorrectly reuse control-change coverage for onLoad."
        }]
      }))
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.report.diagnostics.some((item) => item.code === "agent.patch.native_rule_action_mismatch"),
      true
    );
  });

  it("rejects shrinking deterministic native rule coverage or omitting its residual behavior", async () => {
    const sourceRef = "source.form.jsp.fd_jsp.script.1";
    const sourceDraft = sampleSourceDraft({
      scripts: {
        source: "sysform-jsp",
        sources: [{
          id: "fd_jsp.script.1",
          sourceRef,
          javascript: "AttachXFormValueChangeEventById('fd_amount', function(value){ /* A/B */ })",
          functionAudit: { matched: [], violations: [] }
        }]
      }
    });
    const rules = ["A", "B"].map((value) => ({
      id: `linkage.fd_amount.contains.${value}`,
      trigger: "change",
      source: "fd_amount",
      logic: "and",
      when: [{ field: "fd_amount", op: "contains", value }],
      effects: [{ type: "visible", target: "fd_subject", value: true }],
      else: [{ type: "visible", target: "fd_subject", value: false }],
      meta: { sourceJsp: sourceRef },
      translationStatus: "executable"
    }));
    const dslDraft = sampleDraftDsl({
      workflow: undefined,
      formRules: { linkage: rules },
      scripts: {
        source: "sysform-jsp",
        actions: [{
          id: "fd_jsp.script.1.event.1",
          name: "onChange",
          event: "onChange",
          scope: "control",
          controlId: "fd_amount",
          function: "function onChange(value) { /* review */ }",
          translationStatus: "needs_review",
          sourceRefs: [sourceRef],
          coverage: {
            status: "partial",
            nativeRules: rules.map((rule) => rule.id),
            residuals: [{ code: "script.residual.field_value_assignment" }]
          },
          functionMappings: []
        }]
      }
    });
    const result = await runAgentReview(sourceDraft, dslDraft, {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [{
          op: "replace",
          path: "/scripts/actions/0/coverage",
          value: { status: "covered", nativeRules: [rules[1].id], residuals: [] },
          sourceRefs: [sourceRef],
          evidence: ["Only the final B branch was selected."],
          confidence: 0.91,
          rationale: "Incorrectly claim one branch as complete coverage."
        }]
      }))
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.report.diagnostics.some((item) =>
        item.code === "agent.patch.native_rules_deterministic_evidence_changed" ||
        item.code === "agent.patch.native_rules_incomplete"
      ),
      true
    );

    const omission = await runAgentReview(sourceDraft, dslDraft, {
      provider: new FakeReviewProvider(reviewResponse({
        patches: [
          {
            op: "replace",
            path: "/scripts/actions/0/function",
            value: "",
            sourceRefs: [sourceRef],
            evidence: ["The native rules cover visibility but not the helper assignment."],
            confidence: 0.91,
            rationale: "Incorrectly omit the remaining helper assignment."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/translationStatus",
            value: "omitted",
            sourceRefs: [sourceRef],
            evidence: ["All native rule ids are retained."],
            confidence: 0.91,
            rationale: "Incorrectly close an action with deterministic residual behavior."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/functionMappings",
            value: [{
              source: "legacy row visibility",
              target: "native formRules.linkage",
              basis: "native-form-rule",
              reviewRequired: false
            }],
            sourceRefs: [sourceRef],
            evidence: ["The row visibility portion is native."],
            confidence: 0.91,
            rationale: "Record only the native portion."
          },
          {
            op: "replace",
            path: "/scripts/actions/0/coverage",
            value: { status: "covered", nativeRules: rules.map((rule) => rule.id), residuals: [] },
            sourceRefs: [sourceRef],
            evidence: ["All matching native rule ids are present."],
            confidence: 0.91,
            rationale: "Incorrectly clear a deterministic field assignment residual."
          }
        ]
      }))
    });

    assert.equal(omission.ok, false);
    assert.equal(
      omission.report.diagnostics.some((item) => item.code === "agent.patch.deterministic_residual_omitted"),
      true
    );
  });

  it("rejects a non-empty D-only helper assignment that clears the real A/B/C/D/empty residual branches", async () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac");
    const dslDraft = draftSourceDraft(sourceDraft);
    const actionIndex = dslDraft.scripts.actions.findIndex((action) => (
      action.event === "onChange" &&
      action.coverage?.residuals?.filter((residual) => (
        residual.code === "script.residual.field_value_assignment"
      )).length === 5
    ));
    assert.notEqual(actionIndex, -1);
    const action = dslDraft.scripts.actions[actionIndex];
    const assignmentResiduals = action.coverage.residuals.filter((residual) => (
      residual.code === "script.residual.field_value_assignment"
    ));
    assert.deepEqual(
      assignmentResiduals.map((residual) => residual.evidence),
      [
        "isTypeC.value=\"A\"",
        "isTypeC.value=\"B\"",
        "isTypeC.value=\"C\"",
        "isTypeC.value=\"D\"",
        "isTypeC.value=\"\""
      ]
    );
    const target = assignmentResiduals[0].target;
    const dOnlyFunction = [
      "function onChange(value) {",
      `  // MKXFORM.setValue(${JSON.stringify(target)}, \"A\") is only a comment`,
      `  var fakeBranch = ${JSON.stringify(`MKXFORM.setValue(${JSON.stringify(target)}, \"B\")`)}`,
      `  MKXFORM.setValue(${JSON.stringify(target)}, \"D\")`,
      "}"
    ].join("\n");
    const rejected = applyEvidenceBackedPatches(
      dslDraft,
      assignmentClosurePatches(actionIndex, action, dOnlyFunction),
      {
        sourceRefs: collectSourceRefs(sourceDraft),
        sourceDraft
      }
    );

    assert.equal(rejected.ok, false);
    const diagnostic = rejected.diagnostics.find((item) => (
      item.code === "agent.patch.field_value_assignment_incomplete"
    ));
    assert.ok(diagnostic);
    assert.deepEqual(
      diagnostic.details.missingAssignments.map((assignment) => assignment.value),
      ["\"A\"", "\"B\"", "\"C\"", "\"\""]
    );
    assert.deepEqual(diagnostic.details.observedAssignments, [{ target, value: "\"D\"" }]);
  });

  it("rejects the former A/B/C-only onLoad mapping that hard-hides the D row", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac");
    const dslDraft = draftSourceDraft(sourceDraft);
    const actionIndex = dslDraft.scripts.actions.findIndex((action) => (
      action.event === "onLoad" && action.runWhen?.viewStatusIn?.includes("edit")
    ));
    assert.notEqual(actionIndex, -1);
    const action = dslDraft.scripts.actions[actionIndex];
    const incompleteFunction = [
      "function onLoad() {",
      "  var value = MKXFORM.getValue(\"fd_3c66895473ff5c\")",
      "  var showOne = value === \"A\"",
      "  var showTwo = value === \"B\"",
      "  var showThree = value === \"C\"",
      "  MKXFORM.setFieldAttr(\"fd_one_row\", showOne ? 5 : 4)",
      "  MKXFORM.setFieldAttr(\"fd_one_row\", showOne ? 3 : 6)",
      "  MKXFORM.setFieldAttr(\"fd_two_row\", showTwo ? 5 : 4)",
      "  MKXFORM.setFieldAttr(\"fd_two_row\", showTwo ? 3 : 6)",
      "  MKXFORM.setFieldAttr(\"fd_three_row\", showThree ? 5 : 4)",
      "  MKXFORM.setFieldAttr(\"fd_three_row\", showThree ? 3 : 6)",
      "  MKXFORM.setFieldAttr(\"fd_four_row\", 4)",
      "  MKXFORM.setFieldAttr(\"fd_four_row\", 6)",
      "}"
    ].join("\n");
    const rejected = applyEvidenceBackedPatches(
      dslDraft,
      assignmentClosurePatches(actionIndex, action, incompleteFunction),
      {
        sourceRefs: collectSourceRefs(sourceDraft),
        sourceDraft
      }
    );

    assert.equal(rejected.ok, false);
    const diagnostic = rejected.diagnostics.find((item) => (
      item.code === "agent.patch.row_marker_effect_incomplete"
    ));
    assert.ok(diagnostic);
    assert.deepEqual(diagnostic.details.missingEffects, [
      { target: "fd_four_row", attribute: 5 },
      { target: "fd_four_row", attribute: 3 }
    ]);
  });

  it("accepts edit onLoad only when row conditions derive from the original source field", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac");
    const dslDraft = draftSourceDraft(sourceDraft);
    const actionIndex = dslDraft.scripts.actions.findIndex((action) => (
      action.event === "onLoad" && action.runWhen?.viewStatusIn?.includes("edit")
    ));
    assert.notEqual(actionIndex, -1);
    const action = dslDraft.scripts.actions[actionIndex];
    const reviewedFunction = (fieldId) => [
      "function onLoad() {",
      `  var rawValue = MKXFORM.getValue(${JSON.stringify(fieldId)})`,
      "  var value = Array.isArray(rawValue) ? rawValue[0] : rawValue",
      ...completeOnLoadRowBranch("if", "A", "fd_one_row"),
      ...completeOnLoadRowBranch("else if", "B", "fd_two_row"),
      ...completeOnLoadRowBranch("else if", "C", "fd_three_row"),
      ...completeOnLoadRowBranch("else if", "D", "fd_four_row"),
      ...completeOnLoadRowBranch("else", "", undefined),
      "}"
    ].join("\n");
    const apply = (fieldId) => applyEvidenceBackedPatches(
      dslDraft,
      assignmentClosurePatches(actionIndex, action, reviewedFunction(fieldId)),
      { sourceRefs: collectSourceRefs(sourceDraft), sourceDraft }
    );

    const correct = apply("fd_3c66895473ff5c");
    const wrong = apply("fd_3c6a790de91eb0");

    assert.equal(correct.ok, true, JSON.stringify(correct.diagnostics));
    assert.equal(wrong.ok, false);
    assert.equal(
      wrong.diagnostics.some((item) => (
        item.code === "agent.patch.row_marker_semantics_unverified" &&
        item.details.conditionalReason === "target_row_condition_chain_changed" &&
        item.details.conditionalDetails?.observedConditions?.every((condition) => (
          condition.operand === "field:fd_3c6a790de91eb0"
        ))
      )),
      true,
      JSON.stringify(wrong.diagnostics)
    );
  });

  it("rejects complete assignment and row calls hidden in an unreachable if(false) branch", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac");
    const dslDraft = draftSourceDraft(sourceDraft);
    const actionIndex = dslDraft.scripts.actions.findIndex((action) => (
      action.event === "onChange" &&
      action.coverage?.residuals?.filter((residual) => (
        residual.code === "script.residual.field_value_assignment"
      )).length === 5
    ));
    assert.notEqual(actionIndex, -1);
    const action = dslDraft.scripts.actions[actionIndex];
    const target = action.coverage.residuals.find((residual) => (
      residual.code === "script.residual.field_value_assignment"
    )).target;
    const deadCodeFunction = [
      "function onChange(value) {",
      "  if (false) {",
      ...["A", "B", "C", "D", ""].map((value) => (
        `    MKXFORM.setValue(${JSON.stringify(target)}, ${JSON.stringify(value)})`
      )),
      ...["fd_one_row", "fd_two_row", "fd_three_row", "fd_four_row"].flatMap((marker) => [
        `    MKXFORM.setFieldAttr(${JSON.stringify(marker)}, 5)`,
        `    MKXFORM.setFieldAttr(${JSON.stringify(marker)}, 4)`,
        `    MKXFORM.setFieldAttr(${JSON.stringify(marker)}, 3)`,
        `    MKXFORM.setFieldAttr(${JSON.stringify(marker)}, 6)`
      ]),
      "  }",
      "}"
    ].join("\n");
    const rejected = applyEvidenceBackedPatches(
      dslDraft,
      assignmentClosurePatches(actionIndex, action, deadCodeFunction),
      {
        sourceRefs: collectSourceRefs(sourceDraft),
        sourceDraft
      }
    );

    assert.equal(rejected.ok, false);
    assert.equal(
      rejected.diagnostics.some((item) => (
        item.code === "agent.patch.field_value_assignment_semantics_unverified"
      )),
      true
    );
    assert.equal(
      rejected.diagnostics.some((item) => item.code === "agent.patch.row_marker_native_effect_duplicated"),
      true
    );
  });

  it("rejects unconditional assignment and row-state enumeration without source branch association", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac");
    const dslDraft = draftSourceDraft(sourceDraft);
    const actionIndex = dslDraft.scripts.actions.findIndex((action) => (
      action.event === "onChange" &&
      action.coverage?.residuals?.filter((residual) => (
        residual.code === "script.residual.field_value_assignment"
      )).length === 5
    ));
    assert.notEqual(actionIndex, -1);
    const action = dslDraft.scripts.actions[actionIndex];
    const target = action.coverage.residuals.find((residual) => (
      residual.code === "script.residual.field_value_assignment"
    )).target;
    const enumeratedFunction = [
      "function onChange(value) {",
      ...["A", "B", "C", "D", ""].map((value) => (
        `  MKXFORM.setValue(${JSON.stringify(target)}, ${JSON.stringify(value)})`
      )),
      ...["fd_one_row", "fd_two_row", "fd_three_row", "fd_four_row"].flatMap((marker) => [
        `  MKXFORM.setFieldAttr(${JSON.stringify(marker)}, 5)`,
        `  MKXFORM.setFieldAttr(${JSON.stringify(marker)}, 4)`,
        `  MKXFORM.setFieldAttr(${JSON.stringify(marker)}, 3)`,
        `  MKXFORM.setFieldAttr(${JSON.stringify(marker)}, 6)`
      ]),
      "}"
    ].join("\n");
    const rejected = applyEvidenceBackedPatches(
      dslDraft,
      assignmentClosurePatches(actionIndex, action, enumeratedFunction),
      {
        sourceRefs: collectSourceRefs(sourceDraft),
        sourceDraft
      }
    );

    assert.equal(rejected.ok, false);
    assert.equal(
      rejected.diagnostics.some((item) => (
        item.code === "agent.patch.field_value_assignment_semantics_unverified"
      )),
      true
    );
    assert.equal(
      rejected.diagnostics.some((item) => item.code === "agent.patch.row_marker_native_effect_duplicated"),
      true
    );
  });

  it("rejects reordered else-if branches even when every assignment and row state is present", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac");
    const dslDraft = draftSourceDraft(sourceDraft);
    const actionIndex = dslDraft.scripts.actions.findIndex((action) => (
      action.event === "onChange" &&
      action.coverage?.residuals?.filter((residual) => (
        residual.code === "script.residual.field_value_assignment"
      )).length === 5
    ));
    assert.notEqual(actionIndex, -1);
    const action = dslDraft.scripts.actions[actionIndex];
    const target = action.coverage.residuals.find((residual) => (
      residual.code === "script.residual.field_value_assignment"
    )).target;
    const reorderedFunction = [
      "function onChange(value) {",
      ...completeVisibilityBranch("if", "B", "fd_two_row", target),
      ...completeVisibilityBranch("else if", "A", "fd_one_row", target),
      ...completeVisibilityBranch("else if", "C", "fd_three_row", target),
      ...completeVisibilityBranch("else if", "D", "fd_four_row", target),
      ...completeVisibilityBranch("else", "", undefined, target),
      "}"
    ].join("\n");
    const rejected = applyEvidenceBackedPatches(
      dslDraft,
      assignmentClosurePatches(actionIndex, action, reorderedFunction),
      {
        sourceRefs: collectSourceRefs(sourceDraft),
        sourceDraft
      }
    );

    assert.equal(rejected.ok, false);
    const assignmentDiagnostic = rejected.diagnostics.find((item) => (
      item.code === "agent.patch.field_value_assignment_semantics_unverified"
    ));
    assert.ok(assignmentDiagnostic);
    assert.equal(assignmentDiagnostic.details.reason, "condition_chain_changed");
    assert.equal(
      rejected.diagnostics.some((item) => item.code === "agent.patch.row_marker_native_effect_duplicated"),
      true
    );
  });

  it("rejects condition operands that are undefined or declared from an unrelated field", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac");
    const dslDraft = draftSourceDraft(sourceDraft);
    const actionIndex = dslDraft.scripts.actions.findIndex((action) => (
      action.event === "onChange" &&
      action.coverage?.residuals?.filter((residual) => (
        residual.code === "script.residual.field_value_assignment"
      )).length === 5
    ));
    assert.notEqual(actionIndex, -1);
    const action = dslDraft.scripts.actions[actionIndex];
    const target = action.coverage.residuals.find((residual) => (
      residual.code === "script.residual.field_value_assignment"
    )).target;
    const validLines = [
      "function onChange(value) {",
      ...completeVisibilityBranch("if", "A", "fd_one_row", target),
      ...completeVisibilityBranch("else if", "B", "fd_two_row", target),
      ...completeVisibilityBranch("else if", "C", "fd_three_row", target),
      ...completeVisibilityBranch("else if", "D", "fd_four_row", target),
      ...completeVisibilityBranch("else", "", undefined, target),
      "}"
    ];
    const cases = [
      ["undefined operand", [], "condition_not_statically_supported"],
      ["declared unrelated field operand", [
        `  var wrong = MKXFORM.getValue(${JSON.stringify(target)})`
      ], "condition_chain_changed"]
    ];

    for (const [label, declarations, expectedReason] of cases) {
      const reviewedFunction = [
        validLines[0],
        ...declarations,
        ...validLines.slice(1)
      ].join("\n").replaceAll("value.indexOf", "wrong.indexOf");
      const rejected = applyEvidenceBackedPatches(
        dslDraft,
        assignmentClosurePatches(actionIndex, action, reviewedFunction),
        {
          sourceRefs: collectSourceRefs(sourceDraft),
          sourceDraft
        }
      );

      assert.equal(rejected.ok, false, label);
      const diagnostic = rejected.diagnostics.find((item) => (
        item.code === "agent.patch.field_value_assignment_semantics_unverified"
      ));
      assert.ok(diagnostic, label);
      assert.equal(diagnostic.details.reason, expectedReason, label);
      assert.equal(
        rejected.diagnostics.some((item) => item.code === "agent.patch.row_marker_native_effect_duplicated"),
        true,
        label
      );
    }
  });

  it("rejects arbitrary member access derived from the onChange value parameter", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac");
    const dslDraft = draftSourceDraft(sourceDraft);
    const actionIndex = dslDraft.scripts.actions.findIndex((action) => (
      action.event === "onChange" &&
      action.coverage?.residuals?.filter((residual) => (
        residual.code === "script.residual.field_value_assignment"
      )).length === 5
    ));
    assert.notEqual(actionIndex, -1);
    const action = dslDraft.scripts.actions[actionIndex];
    const target = action.coverage.residuals.find((residual) => (
      residual.code === "script.residual.field_value_assignment"
    )).target;
    const memberFunction = [
      "function onChange(value) {",
      ...completeVisibilityBranch("if", "A", "fd_one_row", target),
      ...completeVisibilityBranch("else if", "B", "fd_two_row", target),
      ...completeVisibilityBranch("else if", "C", "fd_three_row", target),
      ...completeVisibilityBranch("else if", "D", "fd_four_row", target),
      ...completeVisibilityBranch("else", "", undefined, target),
      "}"
    ].join("\n").replaceAll("value.indexOf", "value.foo.indexOf");
    const rejected = applyEvidenceBackedPatches(
      dslDraft,
      assignmentClosurePatches(actionIndex, action, memberFunction),
      {
        sourceRefs: collectSourceRefs(sourceDraft),
        sourceDraft
      }
    );

    assert.equal(rejected.ok, false);
    assert.equal(
      rejected.diagnostics.some((item) => (
        item.code === "agent.patch.field_value_assignment_semantics_unverified" &&
        item.details.reason === "condition_not_statically_supported"
      )),
      true
    );
    assert.equal(
      rejected.diagnostics.some((item) => item.code === "agent.patch.row_marker_native_effect_duplicated"),
      true
    );
  });

  it("accepts a renamed parameter through alias, Array.isArray first-value, and String defaulting", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac");
    const dslDraft = draftSourceDraft(sourceDraft);
    const actionIndex = dslDraft.scripts.actions.findIndex((action) => (
      action.event === "onChange" &&
      action.coverage?.residuals?.filter((residual) => (
        residual.code === "script.residual.field_value_assignment"
      )).length === 5
    ));
    assert.notEqual(actionIndex, -1);
    const action = dslDraft.scripts.actions[actionIndex];
    const target = action.coverage.residuals.find((residual) => (
      residual.code === "script.residual.field_value_assignment"
    )).target;
    const normalizedFunction = [
      "function onChange(changedValue) {",
      "  var firstValue = Array.isArray(changedValue) ? changedValue[0] : changedValue",
      "  var alias = firstValue",
      ...completeAssignmentBranch("if", "A", target),
      ...completeAssignmentBranch("else if", "B", target),
      ...completeAssignmentBranch("else if", "C", target),
      ...completeAssignmentBranch("else if", "D", target),
      ...completeAssignmentBranch("else", "", target),
      "}"
    ].join("\n").replaceAll(
      "value.indexOf",
      "String(alias || \"\").indexOf"
    );
    const accepted = applyEvidenceBackedPatches(
      dslDraft,
      assignmentClosurePatches(actionIndex, action, normalizedFunction),
      {
        sourceRefs: collectSourceRefs(sourceDraft),
        sourceDraft
      }
    );

    assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));
  });

  it("accepts clearing assignment residuals when every evidenced target/value pair is executable", async () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac");
    const dslDraft = draftSourceDraft(sourceDraft);
    const actionIndex = dslDraft.scripts.actions.findIndex((action) => (
      action.event === "onChange" &&
      action.coverage?.residuals?.some((residual) => (
        residual.code === "script.residual.field_value_assignment"
      ))
    ));
    assert.notEqual(actionIndex, -1);
    const action = dslDraft.scripts.actions[actionIndex];
    const target = action.coverage.residuals.find((residual) => (
      residual.code === "script.residual.field_value_assignment"
    )).target;
    const completeFunction = [
      "function onChange(value) {",
      ...completeAssignmentBranch("if", "A", target),
      ...completeAssignmentBranch("else if", "B", target),
      ...completeAssignmentBranch("else if", "C", target),
      ...completeAssignmentBranch("else if", "D", target),
      ...completeAssignmentBranch("else", "", target),
      "}"
    ].join("\n");
    const accepted = applyEvidenceBackedPatches(
      dslDraft,
      assignmentClosurePatches(actionIndex, action, completeFunction),
      {
        sourceRefs: collectSourceRefs(sourceDraft),
        sourceDraft
      }
    );

    assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));
    assert.equal(accepted.dslDraft.scripts.actions[actionIndex].translationStatus, "mapped");
    assert.deepEqual(accepted.dslDraft.scripts.actions[actionIndex].coverage.residuals, []);
  });

  it("fails closed when helper-only JavaScript relies on incomplete native row coverage", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac");
    const dslDraft = draftSourceDraft(sourceDraft);
    const actionIndex = dslDraft.scripts.actions.findIndex((action) => (
      action.event === "onChange" && action.coverage?.nativeRules?.length === 4
    ));
    assert.notEqual(actionIndex, -1);
    const action = dslDraft.scripts.actions[actionIndex];
    const target = action.coverage.residuals.find((residual) => (
      residual.code === "script.residual.field_value_assignment"
    )).target;
    const incompleteRule = dslDraft.formRules.linkage.find((rule) => (
      rule.id === action.coverage.nativeRules[0]
    ));
    incompleteRule.else = incompleteRule.else.filter((effect) => effect.type !== "required");
    const helperOnly = [
      "function onChange(value) {",
      ...completeAssignmentBranch("if", "A", target),
      ...completeAssignmentBranch("else if", "B", target),
      ...completeAssignmentBranch("else if", "C", target),
      ...completeAssignmentBranch("else if", "D", target),
      ...completeAssignmentBranch("else", "", target),
      "}"
    ].join("\n");

    const rejected = applyEvidenceBackedPatches(
      dslDraft,
      assignmentClosurePatches(actionIndex, action, helperOnly),
      { sourceRefs: collectSourceRefs(sourceDraft), sourceDraft }
    );

    assert.equal(rejected.ok, false);
    assert.equal(
      rejected.diagnostics.some((item) => item.code === "agent.patch.row_marker_native_coverage_incomplete"),
      true,
      JSON.stringify(rejected.diagnostics)
    );
  });

  it("closes already native-covered JSP actions even when source contains DOM helper noise", async () => {
    const sourceDraft = sampleSourceDraft({
      scripts: {
        source: "sysform-jsp",
        sources: [{
          id: "fd_jsp.script.1",
          sourceRef: "source.form.jsp.fd_jsp.script.1",
          javascript: "AttachXFormValueChangeEventById('fd_amount', function(value){ if (value.indexOf('A') >= 0) { common_dom_row_set_show_required_reset('fd_subject_row', true, true, false); } else { common_dom_row_set_show_required_reset('fd_subject_row', false, false, false); } setITTableValidate(); document.getElementsByTagName('img')[0].setAttribute('onclick','x') })",
          functionAudit: { matched: [], violations: [] }
        }]
      }
    });
    sourceDraft.form.layout.rows[0].sourceMarkers = ["fd_subject_row"];
    const form = sampleForm();
    form.layout.mkTree[0].sourceMarkers = ["fd_subject_row"];
    const dslDraft = sampleDraftDsl({
      form,
      workflow: undefined,
      formRules: {
        linkage: [{
          id: "linkage.fd_amount.contains.A",
          trigger: "change",
          source: "fd_amount",
          logic: "and",
          when: [{ field: "fd_amount", op: "contains", value: "A" }],
          effects: [
            { type: "visible", target: "fd_subject_row", value: true },
            { type: "required", target: "fd_subject_row", value: true }
          ],
          else: [
            { type: "visible", target: "fd_subject_row", value: false },
            { type: "required", target: "fd_subject_row", value: false }
          ],
          meta: {
            sourceJsp: "source.form.jsp.fd_jsp.script.1",
            sourceActionKey: "source.form.jsp.fd_jsp.script.1#onChange@0"
          },
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
          function: "function onChange(value) {\n  // Source JSP JavaScript includes complementary fd_subject_row visible/required branches.\n  if (value.indexOf('A') >= 0) {\n    common_dom_row_set_show_required_reset('fd_subject_row', true, true, false)\n  } else {\n    common_dom_row_set_show_required_reset('fd_subject_row', false, false, false)\n  }\n}",
          translationStatus: "needs_review",
          sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
          sourceActionKey: "source.form.jsp.fd_jsp.script.1#onChange@0",
          branchProvenance: buildScriptBranchProvenance({
            event: "onChange",
            source: "AttachXFormValueChangeEventById('fd_amount', function(value){ if (value.indexOf('A') >= 0) { common_dom_row_set_show_required_reset('fd_subject_row', true, true, false); } else { common_dom_row_set_show_required_reset('fd_subject_row', false, false, false); } setITTableValidate(); document.getElementsByTagName('img')[0].setAttribute('onclick','x') })",
            sourceRef: "source.form.jsp.fd_jsp.script.1",
            sourceActionKey: "source.form.jsp.fd_jsp.script.1#onChange@0"
          }),
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

    assert.equal(result.ok, true, JSON.stringify(result.report?.diagnostics || result.diagnostics));
    assert.equal(result.dsl.scripts.actions[0].translationStatus, "omitted");
    assert.equal(result.dsl.scripts.actions[0].function, "");
    assert.equal(result.dsl.scripts.actions[0].functionMappings[0].basis, "native-form-rule");
    assert.deepEqual(result.dsl.scripts.actions[0].coverage.nativeRules, ["linkage.fd_amount.contains.A"]);
  });

  it("accepts semantic detail-row visibility patches without treating onclick binding as residual", async () => {
    const sourceJavascript = [
      "function controlDisplay(value,i){",
      "var hidden=document.getElementsByName(\"extendDataFormInfo.value(fd_detail.\"+i+\".fd_isout_val)\")[0];",
      "if(value==\"gh\") {",
      "hidden.value=\"true\";",
      "document.getElementsByName(\"extendDataFormInfo.value(fd_detail.\"+i+\".fd_replacement_asset)\")[0].style.display=\"\";",
      "document.getElementsByName(\"extendDataFormInfo.value(fd_detail.\"+i+\".fd_replacement_asset)\")[0].setAttribute(\"validate\",\"required\");",
      "} else {",
      "hidden.value=\"\";",
      "document.getElementsByName(\"extendDataFormInfo.value(fd_detail.\"+i+\".fd_replacement_asset)\")[0].style.display=\"none\";",
      "document.getElementsByName(\"extendDataFormInfo.value(fd_detail.\"+i+\".fd_replacement_asset)\")[0].setAttribute(\"validate\",\"\");",
      "}",
      "}",
      "var xg=document.getElementsByName(\"extendDataFormInfo.value(fd_detail.\"+i+\".fd_choice)\")[0];",
      "xg.setAttribute(\"onclick\",\"__xformDispatch(this.value);controlDisplay(this.value,\"+i+\")\");"
    ].join(" ");
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
          javascript: sourceJavascript,
          functionAudit: { matched: [], violations: [] }
        }]
      }
    });
    const sourceAction = onlyDraftedScriptAction(sourceDraft);
    const dslDraft = sampleDraftDsl({
      workflow: undefined,
      form,
      scripts: {
        source: "sysform-jsp",
        actions: [{
          ...sourceAction,
          function: "function onChange(value, rowNum, parentRowNum) {\n  // Source JSP JavaScript:\n  // function controlDisplay(value,i){ hidden.value='true'; style.display=''; setAttribute('validate','required'); }\n  // xg.setAttribute('onclick','__xformDispatch(this.value);controlDisplay(this.value,'+i+')');\n}",
          translationStatus: "needs_review",
          coverage: { status: "none", nativeRules: [], residuals: [] },
          functionMappings: []
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

    assert.equal(result.ok, true, JSON.stringify(result.report?.diagnostics || result.diagnostics));
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
    const diagnostic = result.report.diagnostics.find((item) => item.code === "agent.provider.env_missing");
    assert.ok(diagnostic);
    assert.deepEqual(diagnostic.details.missing, ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"]);
  });

  it("uses OPENAI_MODEL for initial and repair Responses requests", async () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/route-validation-lbpm");
    const dslDraft = draftSourceDraft(sourceDraft);
    const requests = [];
    const provider = new OpenAIResponsesReviewProvider({
      env: {
        OPENAI_BASE_URL: "https://example.test/",
        OPENAI_API_KEY: "sk-test-secret",
        OPENAI_MODEL: "configured-review-model"
      },
      fetchImpl: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            output_text: reviewResponse({ patches: [] })
          })
        };
      }
    });

    const initial = await provider.review({ sourceDraft, dslDraft });
    const repaired = await provider.repairReviewResponse({
      sourceDraft,
      dslDraft,
      rawText: "{not json",
      diagnostics: [{
        level: "error",
        code: "agent.response.invalid_json",
        path: "/response",
        message: "Agent review response must be valid JSON."
      }],
      rejectedPatches: [],
      attempt: 1
    });

    assert.equal(initial.ok, true);
    assert.equal(repaired.ok, true);
    assert.deepEqual(requests.map((request) => request.url), [
      "https://example.test/v1/responses",
      "https://example.test/v1/responses"
    ]);
    assert.deepEqual(requests.map((request) => request.body.model), [
      "configured-review-model",
      "configured-review-model"
    ]);
    assert.equal(initial.model, "configured-review-model");
    assert.equal(repaired.model, "configured-review-model");
    assert.equal(provider.metadata().model, "configured-review-model");
  });

  it("passes an optional OPENAI_THINKING setting to Responses requests", async () => {
    let submittedBody;
    const provider = new OpenAIResponsesReviewProvider({
      env: {
        OPENAI_BASE_URL: "https://example.test",
        OPENAI_API_KEY: "sk-test-secret",
        OPENAI_MODEL: "configured-review-model",
        OPENAI_THINKING: "disabled"
      },
      fetchImpl: async (_url, options) => {
        submittedBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ output_text: "{}" })
        };
      }
    });

    await provider.review({ sourceDraft: sampleSourceDraft(), dslDraft: sampleDraftDsl() });

    assert.deepEqual(submittedBody.thinking, { type: "disabled" });
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

  localCorpusIt("builds prompt context from structured source facts without raw XML", () => {
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
    assert.equal(prompt.context.dslDraft.formRules.linkageCount, 6);
    assert.equal(
      prompt.context.dslDraft.formRules.linkage.every((rule) => rule.translationStatus === "executable"),
      true
    );
    assert.equal(
      prompt.context.dslDraft.scripts.actions.some((action) =>
        action.runWhen?.viewStatusIn?.join(",") === "add,edit"
      ),
      true
    );
    assert.equal(prompt.system.includes("Pattern matching is evidence extraction only"), true);
    assert.equal(prompt.system.includes("Whole-row or whole detail-table container visibility/required state must prefer native formRules.linkage"), true);
    assert.equal(prompt.context.jspTranslationPlaybook.id, "jsp-translation-playbook");
    assert.equal(prompt.context.jspTranslationPlaybook.version, "2026-07-12.v6");
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

function onlyDraftedScriptAction(sourceDraft) {
  const actions = draftSourceDraft(sourceDraft).scripts?.actions || [];
  assert.equal(actions.length, 1, "fixture must draft exactly one source-bound script action");
  return actions[0];
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

function assignmentClosurePatches(actionIndex, action, functionText) {
  const patch = (property, value, evidence, rationale) => ({
    op: "replace",
    path: `/scripts/actions/${actionIndex}/${property}`,
    value,
    sourceRefs: action.sourceRefs,
    evidence: [evidence],
    confidence: 0.91,
    rationale
  });
  return [
    patch(
      "function",
      functionText,
      "Translate the helper field assignments with MKXFORM.setValue.",
      "Preserve the source helper-value behavior in the control action."
    ),
    patch(
      "translationStatus",
      "mapped",
      "The proposed function claims to translate all residual assignments.",
      "Mark the action mapped only if closure validation confirms the claim."
    ),
    patch(
      "functionMappings",
      [{
        source: "legacy field .value assignments",
        target: "MKXFORM.setValue",
        basis: "semantic-translation",
        reviewRequired: false
      }],
      "Legacy field assignments map to the supported MKXFORM.setValue API.",
      "Record the proposed assignment mapping."
    ),
    patch(
      "coverage",
      {
        status: "translated",
        nativeRules: action.coverage.nativeRules,
        residuals: []
      },
      "All native rule ids are retained and assignment residuals are claimed translated.",
      "Clear residuals only after validating every evidenced assignment pair."
    )
  ];
}

function completeVisibilityBranch(prefix, value, activeMarker, helperTarget) {
  const rowMarkers = ["fd_one_row", "fd_two_row", "fd_three_row", "fd_four_row"];
  const header = prefix === "else"
    ? "  else {"
    : `  ${prefix} (value.indexOf(${JSON.stringify(value)}) >= 0) {`;
  return [
    header,
    `    MKXFORM.setValue(${JSON.stringify(helperTarget)}, ${JSON.stringify(value)})`,
    ...rowMarkers.flatMap((rowMarker) => {
      const active = rowMarker === activeMarker;
      return [
        `    MKXFORM.setFieldAttr(${JSON.stringify(rowMarker)}, ${active ? 5 : 4})`,
        `    MKXFORM.setFieldAttr(${JSON.stringify(rowMarker)}, ${active ? 3 : 6})`
      ];
    }),
    "  }"
  ];
}

function completeAssignmentBranch(prefix, value, helperTarget) {
  const header = prefix === "else"
    ? "  else {"
    : `  ${prefix} (value.indexOf(${JSON.stringify(value)}) >= 0) {`;
  return [
    header,
    `    MKXFORM.setValue(${JSON.stringify(helperTarget)}, ${JSON.stringify(value)})`,
    "  }"
  ];
}

function completeOnLoadRowBranch(prefix, value, activeMarker) {
  const rowMarkers = ["fd_one_row", "fd_two_row", "fd_three_row", "fd_four_row"];
  const header = prefix === "else"
    ? "  else {"
    : `  ${prefix} (String(value || "") === ${JSON.stringify(value)}) {`;
  return [
    header,
    ...rowMarkers.flatMap((rowMarker) => {
      const active = rowMarker === activeMarker;
      return [
        `    MKXFORM.setFieldAttr(${JSON.stringify(rowMarker)}, ${active ? 5 : 4})`,
        `    MKXFORM.setFieldAttr(${JSON.stringify(rowMarker)}, ${active ? 3 : 6})`
      ];
    }),
    "  }"
  ];
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
