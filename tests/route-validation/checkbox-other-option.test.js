import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { projectTemplate, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture =
  "tests/fixtures/route-validation/checkbox-other-option/route-checkbox-other-option_SysFormTemplate.xml";

describe("checkbox other-option Route case", { concurrency: false }, () => {
  it("maps a source checkbox plus same-cell other text onto one native checkbox", () => {
    const source = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(source);
    const table = dsl.form.fields.find((field) => field.id === "fd_nodes");
    const auth = table.columns.find((column) => column.id === "fd_node_auth");
    const other = table.columns.find((column) => column.id === "fd_node_auth_other");
    const notice = dsl.form.fields.find((field) => field.id === "fd_notice");

    assert.equal(auth.componentId, "xform-checkbox");
    assert.equal(auth.type, "checkbox");
    assert.deepEqual(auth.props.options.at(-1), {
      label: "其他",
      value: "other_",
      type: "other",
      isRequired: true
    });
    assert.equal(other.dataOnly, true);
    assert.equal(notice.componentId, "xform-checkbox");
    assert.equal(checkDraft(dsl).ok, true);
  });

  it("persists one checkbox with a required other option and hides the companion input", async () => {
    const result = await runRouteCase("checkbox-other-option-success");
    const projected = projectTemplate(result.dsl);
    const config = xformConfig(projected);
    const detailModel = config.dataModel.find((model) =>
      model.fdType === "detail" &&
      model.dynamicProps?.detailFieldName === "fd_nodes"
    );
    const auth = detailModel.fdFields.find((field) => field.fdName === "fd_node_auth");
    const other = detailModel.fdFields.find((field) => field.fdName === "fd_node_auth_other");
    const authControl = JSON.parse(auth.fdAttribute).config.controlProps;
    const view = JSON.parse(config.viewModel[0].fdConfig);
    const detailRef = findNode(view, (node) => node.key === detailModel.fdTableName);
    const main = config.dataModel.find((model) => model.fdType === "main");
    const notice = main.fdFields.find((field) => field.fdName === "fd_notice");
    const noticeControl = JSON.parse(notice.fdAttribute).config.controlProps;
    const readbackTable = result.execution.readback.form.fields.find((field) =>
      field.id === "fd_nodes"
    );
    const readbackAuth = readbackTable.columns.find((column) => column.id === "fd_node_auth");
    const readbackOther = readbackTable.columns.find((column) =>
      column.id === "fd_node_auth_other"
    );

    assert.equal(auth.fdType, "checkbox");
    assert.equal(auth.fdDisplay, true);
    assert.equal(other.fdIsStored, true);
    assert.equal(other.fdDisplay, false);
    assert.equal(authControl.desktop.type, "@elem/xform-checkbox");
    assert.equal(authControl.mobile.type, "@elem/xform-m-checkbox");
    assert.equal(authControl.multi, true);
    assert.equal(authControl.optionSource, "custom");
    assert.equal(authControl.direction, "column");
    assert.deepEqual(authControl.options.at(-1), {
      label: "其他",
      value: "other_",
      type: "other",
      colorSwitch: false,
      isRequired: true
    });
    assert.deepEqual(
      detailRef.children.map((child) => child.key),
      ["fd_node_auth", "fd_node_note"]
    );
    assert.equal(noticeControl.desktop.type, "@elem/xform-checkbox");
    assert.equal(noticeControl.multi, true);
    assert.equal(readbackAuth.component, "xform-checkbox");
    assert.equal(readbackOther.dataOnly, true);
    assert.deepEqual(readbackTable.renderedColumnIds, ["fd_node_auth", "fd_node_note"]);
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
