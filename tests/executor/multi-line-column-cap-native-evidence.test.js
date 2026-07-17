import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { preparePersistedTemplate } from "../../src/executor/persistence.js";
import { sampleForm, sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { sampleBaseTemplate, sampleEnvelope, xformConfig } from "../helpers/persistence.js";

const MODES = ["desktop", "mobile"];
const EIGHT_MARKER = "fd_native_cap_eight_row";
const NINE_MARKER = "fd_native_cap_nine_row";
const EIGHT_IDS = Array.from({ length: 8 }, (_, index) => `fd_native_cap_eight_${index + 1}`);
const NINE_IDS = Array.from({ length: 9 }, (_, index) => `fd_native_cap_nine_${index + 1}`);
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/executor/persistence/multi-line-column-cap-1x8-2x8-native-layout.json"
);
const nativeEvidence = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("independent native eight-column layout evidence", () => {
  it("verifies separately authored desktop and mobile 1x8/2x8 fragments", () => {
    const prepared = prepareCapTemplate();

    for (const mode of MODES) {
      assertNativeBoundary(nativeEvidence.nativeLayouts[mode], mode);

      // The observer's canonical form contract reads the desktop render. Promote
      // each endpoint's independently authored fragment into that slot in turn,
      // so both desktop and mobile evidence crosses preparePersistedTemplate.verify.
      const template = independentReadback(prepared.update, mode);
      const readback = prepared.verify(template);

      assert.equal(readback.ok, true, `${mode}: ${JSON.stringify(readback.diagnostics)}`);
      assert.deepEqual(
        readback.form.layoutRows.slice(0, 2).map((row) => ({
          rows: row.rows,
          columns: row.columns,
          fields: row.cells.map((cell) => cell.fieldIds[0]),
          positions: row.cells.map((cell) => [cell.row, cell.column])
        })),
        [
          {
            rows: 1,
            columns: 8,
            fields: EIGHT_IDS,
            positions: EIGHT_IDS.map((_, index) => [0, index])
          },
          {
            rows: 2,
            columns: 8,
            fields: NINE_IDS,
            positions: NINE_IDS.map((_, index) => [Math.floor(index / 8), index % 8])
          }
        ],
        mode
      );
    }
  });

  it("fails closed when either native grid rows or columns drifts", () => {
    const prepared = prepareCapTemplate();

    for (const mode of MODES) {
      for (const [property, value] of [["rows", 1], ["columns", 7]]) {
        const template = independentReadback(prepared.update, mode);
        const { grid, commit } = nativeGridContext(template, NINE_IDS[8]);
        grid.controlProps[property] = value;
        commit();

        const readback = prepared.verify(template);
        assert.equal(readback.ok, false, `${mode} ${property}`);
        assert.equal(
          readback.diagnostics.some((item) =>
            item.code === "readback.form.layout_grid_size_mismatch"
          ),
          true,
          `${mode} ${property}: ${JSON.stringify(readback.diagnostics)}`
        );
      }
    }
  });

  it("fails closed when the ninth native control leaves row 2, column 1", () => {
    const prepared = prepareCapTemplate();

    for (const mode of MODES) {
      const template = independentReadback(prepared.update, mode);
      const { grid, commit } = nativeGridContext(template, NINE_IDS[8]);
      const ninth = grid.children.find((item) => item.children?.[0]?.key === NINE_IDS[8]);
      assert.deepEqual(
        { row: ninth.controlProps.row, column: ninth.controlProps.column },
        { row: 2, column: 1 },
        mode
      );

      ninth.controlProps.row = 1;
      ninth.controlProps.column = 8;
      ninth.controlProps.migrationGridRow = 0;
      ninth.controlProps.migrationColumn = 7;
      commit();

      const readback = prepared.verify(template);
      assert.equal(readback.ok, false, mode);
      assert.equal(
        readback.diagnostics.some((item) =>
          item.code === "readback.form.layout_cell_position_mismatch"
        ),
        true,
        `${mode}: ${JSON.stringify(readback.diagnostics)}`
      );
    }
  });
});

function prepareCapTemplate() {
  const prepared = preparePersistedTemplate({
    dsl: capDsl(),
    envelope: sampleEnvelope(),
    baseTemplate: sampleBaseTemplate()
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
  return prepared;
}

function capDsl() {
  const form = sampleForm();
  const baseField = form.fields.find((field) => field.id === "fd_amount");
  for (const id of [...EIGHT_IDS, ...NINE_IDS]) {
    form.fields.splice(form.fields.length - 1, 0, {
      ...structuredClone(baseField),
      id,
      title: id,
      sourceRef: `source.form.control.${id}`
    });
  }
  form.layout.mkTree.splice(
    0,
    1,
    tableLayoutRow("layout.native-cap-eight", EIGHT_MARKER, EIGHT_IDS, 1),
    tableLayoutRow("layout.native-cap-nine", NINE_MARKER, NINE_IDS, 2)
  );
  return sampleTrustedDsl({ form, workflow: null });
}

function tableLayoutRow(id, markerId, fieldIds, rows) {
  return {
    id,
    componentId: "xform-multi-row-table-layout",
    props: { rows, columns: 8 },
    sourceRef: `source.form.layout.row.${id}`,
    sourceMarkers: [markerId],
    children: fieldIds.map((fieldId, index) => ({
      id: `${id}-cell-${index}`,
      refType: "field",
      refIds: [fieldId],
      sourceRef: `source.form.layout.cell.${id}-cell-${index}`,
      row: Math.floor(index / 8),
      column: index % 8,
      colspan: 1
    }))
  };
}

function independentReadback(projectedTemplate, observedEvidenceMode) {
  const template = structuredClone(projectedTemplate);
  const config = xformConfig(template);
  const view = JSON.parse(config.viewModel[0].fdConfig);

  for (const renderMode of MODES) {
    const evidenceMode = renderMode === "desktop" ? observedEvidenceMode : renderMode;
    replaceCapRows(view, renderMode, nativeEvidence.nativeLayouts[evidenceMode]);
  }

  config.viewModel[0].fdConfig = JSON.stringify(view);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  return template;
}

function replaceCapRows(view, renderMode, layouts) {
  const rows = view.view.render[renderMode][0].children[0].children;
  const eightIndex = rows.findIndex((row) => row.controlProps?.migrationRowId === EIGHT_MARKER);
  const nineIndex = rows.findIndex((row) => row.controlProps?.migrationRowId === NINE_MARKER);
  assert.notEqual(eightIndex, -1, `${renderMode} eight-control writer scaffold`);
  assert.notEqual(nineIndex, -1, `${renderMode} nine-control writer scaffold`);
  rows[eightIndex] = structuredClone(layouts.oneByEight);
  rows[nineIndex] = structuredClone(layouts.twoByEight);
}

function nativeGridContext(template, fieldId) {
  const config = xformConfig(template);
  const view = JSON.parse(config.viewModel[0].fdConfig);
  const rows = view.view.render.desktop[0].children[0].children;
  const row = rows.find((candidate) =>
    candidate.children?.[0]?.children?.some((item) => item.children?.[0]?.key === fieldId)
  );
  assert.ok(row, `independent row containing ${fieldId}`);
  const grid = row.children[0];
  return {
    grid,
    commit() {
      config.viewModel[0].fdConfig = JSON.stringify(view);
      template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    }
  };
}

function assertNativeBoundary(layouts, mode) {
  const oneGrid = layouts.oneByEight.children[0];
  const twoGrid = layouts.twoByEight.children[0];
  assert.deepEqual(
    [oneGrid.controlProps.rows, oneGrid.controlProps.columns, oneGrid.children.length],
    [1, 8, 8],
    `${mode} 1x8`
  );
  assert.deepEqual(
    [twoGrid.controlProps.rows, twoGrid.controlProps.columns, twoGrid.children.length],
    [2, 8, 9],
    `${mode} 2x8`
  );
  assert.deepEqual(
    twoGrid.children.map((item) => [
      item.controlProps.row,
      item.controlProps.column,
      item.children[0].key
    ]),
    NINE_IDS.map((id, index) => [Math.floor(index / 8) + 1, (index % 8) + 1, id]),
    mode
  );
}
