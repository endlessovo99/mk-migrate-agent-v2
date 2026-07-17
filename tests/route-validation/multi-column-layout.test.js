import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMPONENTS_BY_ID } from "../../src/dsl/catalogs.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const designerItemTid =
  "xform-ide-sidebar-tabPane-control-tablelayout-multiLineColumn";
const fixture =
  "tests/fixtures/route-validation/multi-column-cap/route-multi-column-cap_SysFormTemplate.xml";

describe("multi-column layout route fixture", () => {
  it("caps table layouts at eight columns and reflows the ninth control", () => {
    const source = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(source);
    const catalogComponent = COMPONENTS_BY_ID.get("xform-multi-row-table-layout");
    const eightIds = Array.from({ length: 8 }, (_, index) => `fd_eight_${index + 1}`);
    const nineIds = Array.from({ length: 9 }, (_, index) => `fd_nine_${index + 1}`);

    assertLayout(source, dsl, "fd_eight_row", eightIds, { rows: 1, columns: 8 });
    assertLayout(source, dsl, "fd_nine_row", nineIds, { rows: 2, columns: 8 });
    assert.equal(catalogComponent?.target?.desktop, "@elem/layout-grid");
    assert.equal(catalogComponent?.target?.mobile, "@elem/layout-grid");
    assert.equal(catalogComponent?.target?.designerItemTid, designerItemTid);
    assert.equal(catalogComponent?.propsSchema?.properties?.columns?.maximum, 8);
  });
});

function assertLayout(source, dsl, markerId, fieldIds, expectedGrid) {
  const sourceRow = source.form.layout.rows.find((row) =>
    row.sourceMarkers?.includes(markerId)
  );
  const targetRow = dsl.form.layout.mkTree.find((row) =>
    row.sourceMarkers?.includes(markerId)
  );

  assert.equal(sourceRow?.cells.length, 1);
  assert.deepEqual(
    sourceRow?.cells[0].references.map((reference) => reference.referenceId),
    fieldIds
  );
  assert.equal(targetRow?.componentId, "xform-multi-row-table-layout");
  assert.deepEqual(targetRow?.props, expectedGrid);
  assert.deepEqual(targetRow?.children.flatMap((cell) => cell.refIds), fieldIds);
  assert.deepEqual(
    targetRow?.children.map((cell, index) => [cell.row, cell.column]),
    fieldIds.map((_, index) => [Math.floor(index / 8), index % 8])
  );
}
