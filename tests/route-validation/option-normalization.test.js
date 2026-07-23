import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runRouteCase } from "./run-route-case.js";

const invoiceFixture = "tests/fixtures/source/18aac2e235a65c382f6fe264e1dba521";

describe("option normalization Route case", { concurrency: false }, () => {
  it("executes unique target options and preserves the adjacent confirmation structure", async () => {
    const result = await runRouteCase("option-normalization-success");
    const detail = result.dsl.form.fields.find((field) => field.id === "fd_items");
    const location = detail.columns.find((column) => column.id === "fd_location");
    const confirmationRow = result.dsl.form.layout.mkTree.find((row) =>
      row.children.some((cell) => cell.refIds.includes("confirm_hint"))
    );

    assert.deepEqual(location.props.options, [
      { label: "North", value: "N" },
      { label: "South", value: "S" }
    ]);
    assert.deepEqual(confirmationRow.children.map((cell) => cell.refIds), [
      ["confirm_hint"],
      ["fd_confirm"]
    ]);
    assert.equal(result.dryRun.ok, true);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.readback.partitions.form, "verified");
  });

  it("merges distinct source labels that share one stored option value", () => {
    const sourceDraft = cleanSourceFile(invoiceFixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const detail = dslDraft.form.fields.find((field) => field.id === "detailList");
    const taxCode = detail.columns.find((column) => column.id === "spbm");
    const sharedValueOptions = taxCode.props.options.filter((option) => (
      option.value === "2010500000000000000"
    ));

    assert.deepEqual(sharedValueOptions, [{
      label: "劳务-13% / 其他加工劳务-13%",
      value: "2010500000000000000"
    }]);
    assert.equal(
      checkDraft(dslDraft).diagnostics.some((diagnostic) => (
        diagnostic.code === "dsl.form.option_value_duplicate"
      )),
      false
    );
  });
});
