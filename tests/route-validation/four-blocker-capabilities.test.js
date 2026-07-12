import assert from "node:assert/strict";
import { describe } from "node:test";
import { buildWorkflowContent } from "../../src/executor/persistence/workflow-writer.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { persistAndVerify } from "../helpers/persistence.js";
import { localCorpusIt } from "../helpers/local-corpus.js";

const sourceRoot = "tests/fixtures/source";

describe("four blocking route capabilities", () => {
  localCorpusIt("drafts dependent select options and recovers malformed value-change boundaries", () => {
    const draft = draftFixture("1900f4bec4249fc9cde772a43b8a2e81");
    const dependent = draft.scripts.actions.filter((action) =>
      action.recipe?.kind === "dependent_select_options"
    );

    assert.deepEqual(dependent.map((action) => action.event).sort(), ["onChange", "onLoad"]);
    assert.equal(dependent.every((action) => action.translationStatus === "mapped"), true);
    assert.equal(dependent.every((action) => action.recipe.triggerFieldId === "fd_khfl"), true);
    assert.equal(dependent.every((action) => action.recipe.targetFieldId === "fd_3d101d73b41d10"), true);
    assert.deepEqual(dependent[0].recipe.cases[0].options.map((option) => option.value), ["1", "2", "3"]);

    for (const controlId of ["fd_3d09cd843e0440", "fd_3d09cf8e8aea9a"]) {
      const recovered = draft.scripts.actions.find((action) => action.controlId === controlId);
      assert.equal(recovered?.event, "onChange");
      assert.equal(recovered?.scope, "control");
    }
  });

  localCorpusIt("maps the legacy start/recover pair to executable subprocess DSL and one native node", () => {
    const source = cleanSourceFile(`${sourceRoot}/1922c92a772710632f41c544ea59bc7e`);
    const draft = draftSourceDraft(source);
    const nodes = new Map(draft.workflow.nodes.map((node) => [node.id, node]));

    assert.equal(nodes.get("N20").type, "startSubProcess");
    assert.equal(nodes.get("N20").element, "subProcess");
    assert.equal(nodes.get("N20").translationStatus, "executable");
    assert.equal(nodes.get("N20").subProcess.recoverNodeId, "N23");
    assert.equal(nodes.get("N20").subProcess.templateId, "14c96ce79bd257c75f9fe6749c59b4ab");
    assert.equal(nodes.get("N20").subProcess.startParamConfig.length, 4);
    assert.equal(nodes.get("N20").subProcess.recoverParamConfig.length, 2);
    assert.equal(nodes.get("N20").subProcess.variableScope, 2);
    assert.deepEqual(nodes.get("N20").subProcess.recoverRule, {
      type: 1,
      expression: { text: "", value: "" }
    });

    assert.equal(nodes.get("N23").type, "recoverSubProcess");
    assert.equal(nodes.get("N23").element, "subProcess");
    assert.equal(nodes.get("N23").translationStatus, "executable");
    assert.equal(nodes.get("N23").subProcess.startNodeId, "N20");

    const native = buildWorkflowContent(draft.workflow, { form: draft.form });
    const nativeNodes = native.elements.filter((element) => element.type !== "sequenceFlow");
    const nativeEdges = native.elements.filter((element) => element.type === "sequenceFlow");
    const subprocess = nativeNodes.find((node) => node.id === "N20");

    assert.equal(nativeNodes.some((node) => node.id === "N23"), false);
    assert.equal(subprocess.type, "startSubProcess");
    assert.equal(subprocess.element, "subProcess");
    assert.equal(subprocess.startParamConfig.length, 4);
    assert.equal(subprocess.recoverParamConfig.length, 2);
    const subprocessConfig = JSON.parse(subprocess.config);
    assert.equal(subprocessConfig.subProcess.templateId, "14c96ce79bd257c75f9fe6749c59b4ab");
    assert.equal(subprocessConfig.flowType, "2");
    assert.deepEqual(subprocessConfig.recovery, {
      recoverNodeId: "N23",
      variableScope: 2,
      recoverRule: { type: 1, expression: { text: "", value: "" } }
    });
    assert.equal(nativeEdges.some((edge) => edge.sourceRef === "N20" && edge.targetRef === "N3"), true);
    assert.equal(nativeEdges.some((edge) => edge.sourceRef === "N20" && edge.targetRef === "N23"), false);

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation-agent",
      decisions: [{
        id: "subprocess-native-projection",
        status: "accepted",
        decisionType: "subprocess_native_projection",
        sourceRefs: ["source.workflow.node.N20", "source.workflow.node.N23"],
        targetRefs: ["workflow.nodes.N20", "workflow.nodes.N23"],
        rationale: "Structured start/recover evidence maps to one native NewOA subprocess node.",
        result: "accepted"
      }]
    });
    const trust = checkTrust(source, trusted);
    assert.equal(trust.ok, true, JSON.stringify(trust.diagnostics));
    const persistenceDsl = structuredClone(trusted);
    for (const node of persistenceDsl.workflow.nodes) {
      if (["N24", "N25"].includes(node.id)) {
        node.participants = { mode: "empty", reason: "isolated subprocess readback contract" };
      }
    }
    const healthy = persistAndVerify(persistenceDsl).readback;
    assert.equal(healthy.ok, true, JSON.stringify(healthy.diagnostics));
    const mutated = persistAndVerify(persistenceDsl, {
      mutate(template) {
        const lbpm = template.mechanisms.lbpmTemplate[0];
        const content = JSON.parse(lbpm.fdContent);
        const node = content.elements.find((element) => element.id === "N20");
        const config = JSON.parse(node.config);
        config.subProcess.templateId = "wrong-template-id";
        node.config = JSON.stringify(config);
        lbpm.fdContent = JSON.stringify(content);
        return template;
      }
    }).readback;
    assert.equal(mutated.ok, false);
    assert.equal(mutated.diagnostics.some((item) => item.code === "readback.workflow.subprocess_mismatch"), true);
    const recoveryMutated = persistAndVerify(persistenceDsl, {
      mutate(template) {
        const lbpm = template.mechanisms.lbpmTemplate[0];
        const content = JSON.parse(lbpm.fdContent);
        const node = content.elements.find((element) => element.id === "N20");
        const config = JSON.parse(node.config);
        config.recovery.variableScope = 1;
        node.config = JSON.stringify(config);
        lbpm.fdContent = JSON.stringify(content);
        return template;
      }
    }).readback;
    assert.equal(recoveryMutated.ok, false);
    assert.equal(recoveryMutated.diagnostics.some((item) => item.code === "readback.workflow.subprocess_mismatch"), true);
  });

  localCorpusIt("discovers every designer attachment and maps three non-empty submit recipes", () => {
    const source = cleanSourceFile(`${sourceRoot}/1927955f6e544383f46970f48468a743`);
    const draft = draftSourceDraft(source);
    const attachmentIds = draft.form.fields
      .filter((field) => field.type === "attachment")
      .map((field) => field.id)
      .sort();

    assert.deepEqual(attachmentIds, [
      "fd_324d3fee5f0e8e",
      "fd_3d69cddbac1d5c",
      "fd_3d69ce0df07f72",
      "fd_3d69d0a4a24b98",
      "fd_3d69d0ae9d49d4"
    ]);

    const requiredAttachments = draft.scripts.actions.filter((action) =>
      action.recipe?.kind === "attachment_non_empty"
    );
    assert.deepEqual(requiredAttachments.map((action) => action.recipe.fieldId).sort(), [
      "fd_3d69cddbac1d5c",
      "fd_3d69d0a4a24b98",
      "fd_3d69d0ae9d49d4"
    ]);
    assert.equal(requiredAttachments.every((action) => action.event === "onBeforeSubmit"), true);
    assert.equal(requiredAttachments.every((action) => action.translationStatus === "mapped"), true);
    assert.equal(requiredAttachments.every((action) => action.function.includes("MKXFORM.getFormValues")), true);
    assert.equal(requiredAttachments.every((action) => action.function.includes("MKXFORM.modal")), true);
    assert.equal(requiredAttachments.every((action) => action.recipe.message), true);
  });

  localCorpusIt("splits complex detail onLoad into native rules, control event, and lifecycle recipe", () => {
    const draft = draftFixture("19bb55286bd93a6081a33e44c3791374");
    const detailEvents = draft.scripts.actions.filter((action) =>
      action.tableId === "fd_371228ebe5dec2" &&
      action.controlId === "fd_371576f83b26d8" &&
      action.event === "onChange"
    );
    const lifecycle = draft.scripts.actions.find((action) =>
      action.recipe?.kind === "detail_row_lifecycle"
    );
    const nativeCovered = draft.scripts.actions.filter((action) =>
      action.translationStatus === "omitted" && action.coverage?.nativeRules?.length
    );

    assert.equal(detailEvents.length, 1);
    assert.equal(detailEvents[0].translationStatus, "mapped");
    assert.equal(detailEvents[0].recipe.kind, "detail_row_control_state");
    assert.equal(lifecycle.event, "onLoad");
    assert.equal(lifecycle.translationStatus, "mapped");
    assert.equal(lifecycle.recipe.tableId, "fd_371228ebe5dec2");
    assert.equal(lifecycle.function.includes("MKXFORM.getValue"), true);
    assert.equal(lifecycle.function.includes("MKXFORM.updateControl"), true);
    assert.deepEqual(lifecycle.recipe.rowLifecycle, {
      existingRows: "on_load_initialization",
      addedRows: "native_detail_control_event",
      deletedRows: "native_detail_runtime",
      legacyDomCleanup: "not_applicable_native_runtime"
    });
    assert.equal(nativeCovered.length >= 2, true);
    assert.equal(draft.formRules.linkage.every((rule) => rule.translationStatus === "executable"), true);
    const relatedLeader = draft.workflow.nodes.find((node) => node.id === "N53");
    assert.equal(relatedLeader.participants.mode, "configured_person_fallback");
    assert.equal(relatedLeader.translationStatus, "executable");
  });
});

function draftFixture(id) {
  return draftSourceDraft(cleanSourceFile(`${sourceRoot}/${id}`));
}
