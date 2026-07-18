import assert from "node:assert/strict";
import { describe } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { localCorpusIt } from "../helpers/local-corpus.js";

const sourcePath = "tests/fixtures/source/18e2b225a8abe4503405e6e4bb88aba0";

describe("Shanghai Electric 18e2 route regression", () => {
  localCorpusIt("closes the five recorded form migration gaps through common DSL semantics", () => {
    const source = cleanSourceFile(sourcePath);
    const dsl = draftSourceDraft(source);
    const field = (id) => dsl.form.fields.find((candidate) => candidate.id === id);
    const remappedId = (originalId) => dsl.form.fields
      .flatMap((candidate) => [candidate, ...(candidate.columns || [])])
      .find((candidate) => candidate.id === originalId || candidate.sourceProps?.originalId === originalId)?.id;

    assert.equal(dsl.form.fields.length, 95);
    assert.equal(field("fd_person_name").title, "出差人员");

    assert.deepEqual(field("fd_bkpf_waers").props.defaultValue, {
      kind: "literal",
      value: "CNY"
    });
    assert.deepEqual(field("fd_has_traffic_change").props.defaultValue, {
      kind: "literal",
      value: "0"
    });

    assert.deepEqual(field("fd_trafficCity_detail").columns.map((column) => column.id), [
      "fd_traffic_tool",
      "fd_traffic_schedule",
      "fd_traffic_space",
      "fd_traffic_no",
      "fd_traffic_date",
      "fd_traffic_start_add",
      "fd_traffic_end_add",
      "fd_traffic_amount"
    ]);
    const sourceRadioControls = dsl.form.fields
      .flatMap((candidate) => [candidate, ...(candidate.columns || [])])
      .filter((candidate) => candidate.sourceProps?.designerType === "inputRadio");
    assert.ok(sourceRadioControls.length > 0);
    for (const control of sourceRadioControls) {
      assert.equal(control.type, "radio", `${control.id} must preserve the source radio type`);
      assert.equal(
        control.componentId,
        "xform-radio",
        `${control.id} must preserve the source radio component`
      );
    }

    const rowFor = (id) => dsl.form.layout.mkTree.find((row) =>
      row.children.some((child) => child.refIds.includes(id))
    );
    const rowRefs = (id) => rowFor(id).children.flatMap((child) => child.refIds);
    assert.deepEqual(rowRefs("fd_trafficCity_detail"), ["fd_trafficCity_detail"]);
    assert.deepEqual(rowRefs("fd_overnight_days"), ["fd_overnight_days", "fd_allowance_days"]);
    assert.deepEqual(rowRefs("fd_everyday_allowance"), [
      "fd_everyday_allowance",
      "fd_35b0aaa40e93c8",
      "fd_allowance_chg"
    ]);
    assert.deepEqual(rowRefs("fd_allowance_bg"), [
      "fd_allowance_bg",
      "fd_3e9c3d229756d2",
      "fd_allowance_fzh"
    ]);
    assert.deepEqual(rowRefs("fd_total_allowance"), ["fd_3e9c3c5d538988", "fd_total_allowance"]);
    assert.deepEqual(rowRefs("fd_hotel"), ["fd_hotel", "fd_other_total_amount"]);
    for (const id of [
      "fd_trafficCity_detail",
      "fd_bus_metro_taxi_detail",
      "fd_train_detail",
      "fd_flight_detail"
    ]) {
      assert.equal(rowFor(id).componentId, "xform-flex-1-1-layout", id);
    }
    assert.equal(
      dsl.form.layout.mkTree.some((row) =>
        row.sourceRef.startsWith("source.form.layout.row.row-14") &&
        row.componentId === "xform-multi-row-table-layout"
      ),
      false
    );

    for (const id of [
      "fd_is_allowance_bg",
      "fd_allowance_days",
      "fd_everyday_allowance",
      "fd_allowance_chg",
      "fd_allowance_bg",
      "fd_allowance_fzh",
      "fd_total_allowance"
    ]) {
      assert.ok(field(id), `missing allowance field ${id}`);
    }

    assert.deepEqual(field("fd_train_total").props.calculation, {
      kind: "aggregate",
      operation: "sum",
      tableId: "fd_train_detail",
      fieldId: "fd_train_inspire"
    });
    assert.deepEqual(field("fd_flight_total_inspire").props.defaultValue, {
      kind: "literal",
      value: 0
    });
    assert.deepEqual(field("fd_total_inspire").props.calculation, {
      kind: "formula",
      expression: "$fd_train_total$ +$fd_flight_total_inspire$",
      displayExpression: "$高铁激励小计K$ +$飞机激励小计L$",
      fieldIds: ["fd_train_total", "fd_flight_total_inspire"]
    });

    assert.equal(field("fd_total_cost").componentId, "xform-calculate");
    assert.deepEqual(field("fd_total_cost").props.calculation.fieldIds, [
      remappedId("fd_domestic_transportation"),
      "fd_total_allowance",
      "fd_hotel",
      "fd_other_total_amount",
      "fd_total_inspire"
    ]);
  });
});
