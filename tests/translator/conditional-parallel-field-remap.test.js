import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/conditional-parallel-long-field";
const sourceFieldId = "fd_route_selection_structural_variant";
const mappedFieldId = "fd_fd955d37adee43fc66d73d";
const nativeWorkflowFixture =
  "tests/fixtures/route-validation/conditional-parallel-long-field/route-conditional-parallel-long-field_native-workflow.json";

describe("conditional-parallel field identity remapping", () => {
  it("keeps long-ID route conditions executable through native readback", () => {
    assert.equal(sourceFieldId.length > 25, true);
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const mappedField = draft.form.fields.find((field) => field.sourceProps?.originalId === sourceFieldId);
    const conditionalEdges = draft.workflow.edges.filter((edge) => edge.source === "QX20");

    assert.ok(mappedField);
    assert.equal(mappedField.id, mappedFieldId);
    assert.equal(mappedField.id.length <= 25, true);
    assert.equal(conditionalEdges.length, 2);
    assert.equal(conditionalEdges.every((edge) => edge.condition.translationStatus === "executable"), true);
    assert.equal(conditionalEdges.every((edge) => edge.condition.critical === true), true);
    for (const edge of conditionalEdges) {
      assert.match(edge.condition.sourceText, new RegExp(`\\$${sourceFieldId}\\$`));
      assert.match(edge.condition.targetText, new RegExp(`\\$${mappedField.id}\\$`));
      assert.doesNotMatch(edge.condition.targetText, new RegExp(`\\$${sourceFieldId}\\$`));
    }

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-07-15T00:00:00.000Z"
    });
    assert.equal(checkTrust(source, trusted).ok, true);
    assert.equal(buildDryRunPlan(trusted).ok, true);

    const prepared = prepareSample(trusted);
    const workflow = JSON.parse(prepared.update.mechanisms.lbpmTemplate[0].fdContent);
    for (const edgeId of ["QE21", "QE22"]) {
      const persistedCondition = workflow.elements.find((element) => element.id === edgeId).formula;
      assert.match(persistedCondition, new RegExp(`\\$${mappedField.id}\\$`));
      assert.doesNotMatch(persistedCondition, new RegExp(`\\$${sourceFieldId}\\$`));
    }

    const nativeReadback = structuredClone(prepared.update);
    nativeReadback.mechanisms.lbpmTemplate[0].fdContent = readFileSync(nativeWorkflowFixture, "utf8");
    const readback = prepared.verify(nativeReadback);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));

    const staleSourceIdReadback = structuredClone(nativeReadback);
    const staleWorkflow = JSON.parse(staleSourceIdReadback.mechanisms.lbpmTemplate[0].fdContent);
    staleWorkflow.elements.find((element) => element.id === "QE21").formula =
      `$${sourceFieldId}$.equals("A") || $${sourceFieldId}$ == "B"`;
    staleSourceIdReadback.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(staleWorkflow);
    assert.equal(
      prepared.verify(staleSourceIdReadback).diagnostics.some((item) =>
        item.code === "readback.workflow.edge_condition_native_semantic_mismatch"
      ),
      true
    );
  });
});
