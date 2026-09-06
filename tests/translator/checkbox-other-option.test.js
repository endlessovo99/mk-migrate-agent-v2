import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture =
  "tests/fixtures/route-validation/checkbox-other-option/route-checkbox-other-option_SysFormTemplate.xml";

describe("checkbox other-option mapping", () => {
  it("keeps source checkboxes as checkbox facts and records the same-cell other companion", () => {
    const source = cleanSourceFile(fixture);
    const auth = source.form.detailTables[0].columns.find((column) => column.id === "fd_node_auth");
    const other = source.form.detailTables[0].columns.find((column) =>
      column.id === "fd_node_auth_other"
    );
    const notice = source.form.controls.find((control) => control.id === "fd_notice");

    assert.equal(auth.sourceType, "checkbox");
    assert.equal(auth.sourceProps.designerType, "inputCheckbox");
    assert.deepEqual(auth.sourceProps.otherTextCompanion, {
      id: "fd_node_auth_other",
      otherRequired: true,
      captionId: "fd_node_auth_other_label",
      caption: "其他："
    });
    assert.equal(other.sourceType, "text");
    assert.equal(notice.sourceType, "checkbox");
  });

  it("folds the other companion into one checkbox option and hides the companion from layout", () => {
    const source = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(source);
    const table = dsl.form.fields.find((field) => field.id === "fd_nodes");
    const auth = table.columns.find((column) => column.id === "fd_node_auth");
    const other = table.columns.find((column) => column.id === "fd_node_auth_other");
    const notice = dsl.form.fields.find((field) => field.id === "fd_notice");
    const renderedColumnIds = table.columns
      .filter((column) => column.dataOnly !== true)
      .map((column) => column.id);

    assert.equal(auth.type, "checkbox");
    assert.equal(auth.componentId, "xform-checkbox");
    assert.deepEqual(auth.props.options, [
      { label: "起草人可修改处理人", value: "1" },
      { label: "编辑主文档", value: "3" },
      { label: "身份重复不跳过", value: "4" },
      { label: "其他", value: "other_", type: "other", isRequired: true }
    ]);
    assert.equal(other.dataOnly, true);
    assert.equal(other.componentId, "xform-input");
    assert.equal(notice.type, "checkbox");
    assert.equal(notice.componentId, "xform-checkbox");
    assert.equal(notice.props.options.some((option) => option.type === "other"), false);
    assert.deepEqual(renderedColumnIds, ["fd_node_auth", "fd_node_note"]);
    assert.equal(checkDraft(dsl).ok, true);
  });
});
