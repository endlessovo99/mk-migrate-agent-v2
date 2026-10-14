import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const root = new URL("../fixtures/executor/persistence/layout-grid-runtime/", import.meta.url);
const provenance = JSON.parse(readFileSync(new URL("provenance.json", root)));

describe("retained native layout-grid renderer", () => {
  it("renders more than eight tracks and merged cells without clamping or wrapping", () => {
    const exports = {};
    const react = {
      useMemo: callback => callback(),
      createElement: (type, props, ...children) => ({ type, props, children })
    };
    runInNewContext(readFileSync(new URL("layout-grid.cjs", root), "utf8"), {
      exports,
      module: { exports },
      require(name) { assert.equal(name, "react"); return react; }
    });
    for (const columns of [9, 11, 17]) {
      const grid = exports.default({ columns, rows: 3, children: [] });
      assert.equal(grid.props.style.gridTemplateColumns.split(" ").length, columns);
      assert.equal(grid.props["data-columns"], columns);
      const cell = exports.GridItem({ column: 2, columnSpan: columns - 1, row: 3 });
      assert.equal(cell.props.style.gridColumn, 2);
      assert.equal(cell.props.style.gridColumnEnd, columns + 1);
      assert.equal(cell.props.style.gridRow, 3);
    }
  });

  it("retains the exact captured JS and CSS used for the capability evidence", () => {
    for (const [file, metadata] of Object.entries(provenance.files)) {
      assert.equal(createHash("sha256").update(readFileSync(new URL(file, root))).digest("hex"), metadata.sha256);
    }
  });
});
