import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { projectTemplate, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture =
  "tests/fixtures/route-validation/hidden-detail-data-column/route-hidden-detail-data-column_SysFormTemplate.xml";

describe("hidden persisted detail-column Route case", { concurrency: false }, () => {
  it("maps explicit source hiding evidence to a data-only detail column", () => {
    const source = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(source);
    const sourceTable = source.form.detailTables.find((field) => field.id === "fd_route_lines");
    const sourceHelper = sourceTable.columns.find((column) => column.id === "fd_route_helper");
    const sourceDesignerHelper = sourceTable.columns.find((column) =>
      column.id === "fd_route_designer_helper"
    );
    const dslTable = dsl.form.fields.find((field) => field.id === "fd_route_lines");
    const dslHelper = dslTable.columns.find((column) => column.id === "fd_route_helper");
    const dslDesignerHelper = dslTable.columns.find((column) =>
      column.id === "fd_route_designer_helper"
    );

    assert.deepEqual(sourceHelper.sourceProps.metadataAttributes, {
      name: "fd_route_helper",
      label: "Stored helper",
      type: "String",
      canDisplay: "false",
      canShow: "false",
      showStatus: "noShow",
      kind: "simple"
    });
    assert.equal(sourceHelper.dataOnly, true);
    assert.equal(sourceDesignerHelper.sourceProps.designerValues.showStatus, "noShow");
    assert.equal(sourceDesignerHelper.sourceProps.metadataAttributes.canDisplay, undefined);
    assert.equal(sourceDesignerHelper.dataOnly, true);
    assert.equal(dslHelper.dataOnly, true);
    assert.equal(dslDesignerHelper.dataOnly, true);
    assert.equal(dslHelper.props.required, undefined);
    assert.equal(checkDraft(dsl).ok, true);
  });

  it("persists the helper for row data without adding it to detail render children", async () => {
    const result = await runRouteCase("hidden-detail-data-column-success");
    const projected = projectTemplate(result.dsl);
    const config = xformConfig(projected);
    const detailModel = config.dataModel.find((model) =>
      model.fdType === "detail" &&
      model.dynamicProps?.detailFieldName === "fd_route_lines"
    );
    const helper = detailModel.fdFields.find((field) => field.fdName === "fd_route_helper");
    const designerHelper = detailModel.fdFields.find((field) =>
      field.fdName === "fd_route_designer_helper"
    );
    const helperControl = JSON.parse(helper.fdAttribute).config.controlProps;
    const view = JSON.parse(config.viewModel[0].fdConfig);
    const detailRef = findNode(view, (node) => node.key === detailModel.fdTableName);
    const readbackTable = result.execution.readback.form.fields.find((field) =>
      field.id === "fd_route_lines"
    );
    const readbackHelper = readbackTable.columns.find((column) =>
      column.id === "fd_route_helper"
    );
    const readbackDesignerHelper = readbackTable.columns.find((column) =>
      column.id === "fd_route_designer_helper"
    );

    assert.equal(helper.fdIsStored, true);
    assert.equal(helper.fdDisplay, false);
    assert.equal(designerHelper.fdIsStored, true);
    assert.equal(designerHelper.fdDisplay, false);
    assert.equal(helperControl.name, "fd_route_helper");
    assert.equal(helperControl["$$tableName"], detailModel.fdTableName);
    assert.equal(helperControl["$$tableType"], "detail");
    assert.deepEqual(
      detailRef.children.map((child) => child.key),
      ["fd_route_visible"]
    );
    assert.equal(readbackHelper.dataOnly, true);
    assert.equal(readbackDesignerHelper.dataOnly, true);
    assert.deepEqual(readbackTable.renderedColumnIds, ["fd_route_visible"]);
    assert.deepEqual(readbackTable.renderedColumnIdsByScene, {
      desktop: ["fd_route_visible"],
      mobile: ["fd_route_visible"]
    });
    assert.equal(result.execution.readback.ok, true);
  });
});

function findNode(value, predicate) {
  if (!value || typeof value !== "object") return undefined;
  if (predicate(value)) return value;
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    const found = findNode(entry, predicate);
    if (found) return found;
  }
  return undefined;
}
