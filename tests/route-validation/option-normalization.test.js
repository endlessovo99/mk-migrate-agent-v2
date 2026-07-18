import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

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
});
