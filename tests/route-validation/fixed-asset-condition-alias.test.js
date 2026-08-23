import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { observeNativeTemplate } from "../../src/executor/persistence/observer.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture =
  "tests/fixtures/source2/16a6c422eed838026b7ba124444891dd";

describe("fixed-asset N12 condition alias Route-validation", () => {
  it("binds both EKP asset-category routes to the current form field", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const sourceEdges = new Map(source.workflow.edges.map((edge) => [edge.id, edge]));
    const draftEdges = new Map(draft.workflow.edges.map((edge) => [edge.id, edge]));

    assert.equal(sourceEdges.get("L13")?.condition, "$fd_assetCategory$ == 0");
    assert.equal(
      sourceEdges.get("L14")?.condition,
      "$fd_374d38dbef88a2$ == 1 || $fd_374d38dbef88a2$ == 2"
    );
    assert.equal(draftEdges.get("L13")?.condition?.targetText, "$fd_assetCategory$ == 0");
    assert.equal(
      draftEdges.get("L14")?.condition?.targetText,
      "$fd_assetCategory$ == 1 || $fd_assetCategory$ == 2"
    );
    assert.equal(draftEdges.get("L14")?.condition?.sourceText, sourceEdges.get("L14")?.condition);

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-08-23T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const observed = observeNativeTemplate(prepared.update);
    const nativeEdges = new Map(
      observed.workflow.value.edges.map((edge) => [edge.id, edge])
    );

    assert.equal(observed.workflow.status, "verified");
    for (const edgeId of ["L13", "L14"]) {
      assert.equal(nativeEdges.get(edgeId)?.condition?.nativeKind, "batch_formula");
      assert.equal(nativeEdges.get(edgeId)?.condition?.nativeStatus, "ok");
    }

    const workflow = JSON.parse(prepared.update.mechanisms.lbpmTemplate[0].fdContent);
    for (const edgeId of ["L13", "L14"]) {
      const edge = workflow.elements.find((element) => element.id === edgeId);
      const formula = JSON.parse(edge.formula);
      assert.equal(edge.formulaType, "formula");
      assert.equal(formula.type, "Batch");
      assert.equal(
        formula.vars.every((variable) =>
          String(variable.value || "").includes("template-id-fd_assetCategory")
        ),
        true
      );
    }

    const dataSourceLoad = trusted.scripts.actions.find((action) =>
      action.event === "onLoad" && action.function.includes('"fd_dataSource", 1')
    );
    assert.equal(dataSourceLoad?.translationStatus, "mapped");
    assert.equal(dataSourceLoad?.coverage?.status, "translated");
    assert.equal(
      dataSourceLoad?.functionMappings?.[0]?.basis,
      "deterministic-static-field-disabled"
    );
  });
});
