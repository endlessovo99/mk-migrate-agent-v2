import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const sourcePath = "tests/fixtures/source/18e2b225a8abe4503405e6e4bb88aba0";

describe("Shanghai Electric 18e2 route regression", () => {
  it("preserves every recognizable calculation as native, script, or explicit manual evidence", () => {
    const source = cleanSourceFile(sourcePath);
    const dsl = draftSourceDraft(source);
    const field = (id) => dsl.form.fields.find((candidate) => candidate.id === id);
    const remappedId = (originalId) => dsl.form.fields
      .flatMap((candidate) => [candidate, ...(candidate.columns || [])])
      .find((candidate) => candidate.id === originalId || candidate.sourceProps?.originalId === originalId)?.id;

    assert.equal(dsl.form.fields.length, 97);
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
    assert.equal(field("fd_train_total").type, "number");
    assert.equal(field("fd_train_total").componentId, "xform-calculate");
    assert.deepEqual(field("fd_flight_total_inspire").props.defaultValue, {
      kind: "literal",
      value: 0
    });
    const flightCalculation = field("fd_flight_total_inspire").props.calculation;
    const flightRawTotal = field(flightCalculation.fieldIds[0]);
    assert.equal(flightCalculation.kind, "formula");
    assert.equal(flightCalculation.expression, `Math.max($${flightRawTotal.id}$, 0)`);
    assert.deepEqual(flightRawTotal.props.calculation, {
      kind: "aggregate",
      operation: "sum",
      tableId: "fd_flight_detail",
      fieldId: "fd_flight_inspire"
    });
    assert.equal(flightRawTotal.componentId, "xform-calculate");
    assert.equal(flightRawTotal.dataOnly, true);
    assert.equal(flightRawTotal.generated, true);
    assert.deepEqual(field("fd_total_inspire").props.calculation, {
      kind: "formula",
      expression: "$fd_train_total$ +$fd_flight_total_inspire$",
      displayExpression: "$高铁激励小计K$ +$飞机激励小计L$",
      fieldIds: ["fd_train_total", "fd_flight_total_inspire"]
    });

    assert.equal(field("fd_total_cost").componentId, "xform-calculate");
    assert.deepEqual(field("fd_total_cost").props.calculation.fieldIds, [
      "fd_3cc1757848e700",
      remappedId("fd_domestic_transportation"),
      "fd_total_allowance",
      "fd_hotel",
      "fd_other_total_amount",
      "fd_total_inspire"
    ]);
    assert.match(field("fd_total_cost").props.calculation.expression, /== 0 \?/);
    assert.match(field("fd_total_cost").props.calculation.expression, /fd_total_inspire/);

    assert.deepEqual(field("fd_payee_total").props.calculation, {
      kind: "aggregate",
      operation: "sum",
      tableId: "fd_payee_list",
      fieldId: "fd_payee_amount"
    });
    assert.deepEqual(field("fd_payee_diff").props.calculation, {
      kind: "formula",
      expression: "$fd_payee_total$ - $fd_total_cost$",
      displayExpression: "$fd_payee_total$ - $fd_total_cost$",
      fieldIds: ["fd_payee_total", "fd_total_cost"]
    });

    const actions = dsl.scripts.actions.filter((action) => action.translationStatus === "mapped");
    assertMappedActions(actions, "source.form.jsp.fd_3bc187ead08638.script.1", {
      onChange: [
        "fd_is_allowance_bg",
        "fd_allowance_chg",
        "fd_allowance_bg",
        "fd_allowance_fzh",
        "fd_start_date",
        "fd_end_date",
        "fd_person_totalnum",
        "fd_everyday_allowance",
        "fd_receipt_amount",
        "fd_3cc1757848e700"
      ],
      global: ["onLoad", "onBeforeSubmit"]
    }, "deterministic-allowance-calculation");
    assertMappedActions(actions, "source.form.jsp.fd_3bb1cfa690b988.script.1", {
      onChange: ["fd_traffic_tool", "fd_traffic_amount", "fd_taxi", "fd_3cc1757848e700"],
      global: ["onLoad", "onBeforeSubmit"]
    }, "deterministic-grouped-detail-calculation");
    const afterDelete = actionsByBasis(actions, "deterministic-grouped-detail-calculation")
      .find((action) => action.event === "onAfterDel");
    assert.equal(actionKey(afterDelete), "onAfterDel:fd_trafficCity_detail:fd_trafficCity_detail");
    assert.match(afterDelete.function, /function onAfterDel\(data\)/);
    assertMappedDetailActions(
      actions,
      "source.form.jsp.fd_3bb43549140132.script.1",
      "fd_train_detail",
      ["fd_train_address", "fd_train_price"]
    );
    assertMappedDetailActions(
      actions,
      "source.form.jsp.fd_3bb4c06b60439c.script.1",
      "fd_flight_detail",
      ["fd_flight_address", "fd_flight_price"]
    );

    const personActions = actionsByBasis(actions, "deterministic-person-text-calculation");
    assert.deepEqual(personActions.map(actionKey), [
      "onChange:fd_person_name:",
      "onChange:fd_target_addr:",
      "onChange:fd_reason:",
      "onLoad::"
    ]);
    assert.match(personActions[0].function, /replace\(\/，\/g, "、"\)/);
    assert.match(personActions[0].function, /MKXFORM\.setValue\("fd_person_totalnum", peopleCount\)/);
    assert.match(personActions[0].function, /MKXFORM\.setValue\("fd_text_description", description\)/);

    const uppercaseActions = actionsByBasis(actions, "deterministic-conditional-total-uppercase");
    assert.deepEqual(uppercaseActions.map(actionKey), [
      "onChange:fd_3cc1757848e700:",
      `onChange:${remappedId("fd_domestic_transportation")}:`,
      "onChange:fd_total_allowance:",
      "onChange:fd_hotel:",
      "onChange:fd_other_total_amount:",
      "onChange:fd_total_inspire:",
      "onChange:fd_total_cost:",
      "onLoad::",
      "onBeforeSubmit::"
    ]);
    assert.match(uppercaseActions[0].function, /MKXFORM\.setValue\("fd_upper_change", chineseAmount\)/);
    assert.match(uppercaseActions.at(-1).function, /context && context\.isDraft/);

    const financeActions = actionsByBasis(actions, "deterministic-finance-detail-generation");
    assert.equal(financeActions.length, 1);
    const financeAction = financeActions[0];
    assert.equal(financeAction.event, "onClick");
    assert.equal(financeAction.controlId, "fd_3ba6ae8cdb4186");
    assert.match(financeAction.function, /MKXFORM\.setDetailValues\(financeDetailTableId, data\)/);
    assert.match(financeAction.function, /var financeDetailTableId = "\$\{table:fd_finance_detail\}"/);
    assert.match(financeAction.function, /var payeeListTableId = "\$\{table:fd_payee_list\}"/);
    assert.doesNotMatch(
      financeAction.function,
      /\b(?:document|DocList_TableInfo|DocList_AddRow|buildDetailTableFieldId|SetXFormFieldValueById|getFormFieldValue|_DocList_[A-Za-z0-9_]+)\b|jQuery|\$\(/
    );
    assert.doesNotThrow(() => Function("MKXFORM", `${financeAction.function}; return onClick;`));
    assertRealFinanceBehavior(financeAction);

    const decisions = dsl.scripts.calculationDecisions;
    const expectedCalculationSources = [
      "source.form.control.fd_traffic_total",
      "source.form.control.fd_domestic_transportation",
      "source.form.control.fd_train_total",
      "source.form.control.fd_flight_total_inspire",
      "source.form.control.fd_total_inspire",
      "source.form.control.fd_total_cost",
      "source.form.control.fd_payee_total",
      "source.form.control.fd_payee_diff",
      "source.form.control.fd_total_accommodationx_tax",
      "source.form.jsp.fd_3bc187ead08638.script.1",
      "source.form.jsp.fd_3bb1cfa690b988.script.1",
      "source.form.jsp.fd_3bb43549140132.script.1",
      "source.form.jsp.fd_3bb43125aca48e.script.1",
      "source.form.jsp.fd_3bb4c06b60439c.script.1",
      "source.form.jsp.fd_3bb4c5d91a565a.script.1",
      "source.form.jsp.fd_3bba8d3507d72e.script.1",
      "source.form.jsp.fd_3cc25d96ee0df2.script.1",
      "source.form.jsp.fd_3cc17629476baa.script.2",
      "source.form.jsp.fd_3d19de502071ba.script.1",
      "source.form.jsp.fd_3ba9ee7d2d381a.script.1",
      "source.form.jsp.fd_3ba6ae8cdb4186.button.1",
      "source.form.jsp.fd_3bc60971c33862.script.1"
    ];
    for (const sourceRef of expectedCalculationSources) {
      assert.ok(
        decisions.some((decision) => decision.sourceRefs.includes(sourceRef)),
        `${sourceRef} must have an explicit calculation decision`
      );
    }
    for (const decision of decisions) {
      assert.ok(["native", "script", "manual"].includes(decision.classification));
      assert.ok(decision.sourceRefs.length > 0, `${decision.id} must retain source evidence`);
      assert.ok(decision.targetRefs.length > 0, `${decision.id} must identify target semantics`);
    }

    assert.equal(decisions.filter((decision) => decision.classification === "native").length, 10);
    assert.equal(decisions.filter((decision) => decision.classification === "script").length, 28);
    assert.equal(decisions.filter((decision) => decision.classification === "manual").length, 3);
    for (const targetRef of ["fd_train_total", "fd_flight_total_inspire"]) {
      const decision = decisions.find(candidate =>
        candidate.classification === "native" && candidate.targetRefs.includes(targetRef)
      );
      assert.deepEqual(decision.semantics.sourceDependentCalls, [{
        name: "inspireTotal",
        handling: "native_dependency_recalculation",
        nativeTarget: "fd_total_inspire"
      }]);
    }
    const manualCodes = new Set(
      decisions.filter((decision) => decision.classification === "manual").map((decision) => decision.code)
    );
    assert.equal(manualCodes.has("calculation.aggregate_nonnegative_clamp"), false);
    assert.equal(manualCodes.has("calculation.detail_row_delete_immediate_recalc_unverified"), false);
    assert.ok(decisions.some((decision) =>
      decision.classification === "manual" &&
      decision.sourceRefs.includes("source.form.jsp.fd_3cc17629476baa.script.2") &&
      decision.targetRefs.includes("fd_payee_diff")
    ));
    assert.ok(decisions.some((decision) =>
      decision.classification === "script" &&
      decision.sourceRefs.includes("source.form.jsp.fd_3d19de502071ba.script.1") &&
      decision.targetRefs.includes("fd_finance_detail")
    ));
    assert.ok(decisions.some((decision) =>
      decision.classification === "manual" &&
      decision.sourceRefs.includes("source.form.jsp.fd_3bb1cfa690b988.script.1")
    ));
    assert.ok(decisions.some((decision) =>
      decision.classification === "manual" &&
      decision.sourceRefs.includes("source.form.jsp.fd_3cc25d96ee0df2.script.1") &&
      decision.targetRefs.includes("fd_payee_list.fd_card_number")
    ));

    const draftCheck = checkDraft(dsl);
    assert.equal(
      draftCheck.diagnostics.filter((diagnostic) => diagnostic.level === "error").length,
      0
    );
  });
});

function assertRealFinanceBehavior(action) {
  const baseValues = {
    fd_3cc1757848e700: 1,
    fd_has_project: 1,
    fd_is_incost: 1,
    fd_text_description: "张三-上海-出差",
    fd_total_allowance: 0,
    fd_train_total: 0,
    fd_flight_total_inspire: 0,
    fd_hotel: 0,
    fd_704dc82f8f85bba4a3355f: 0,
    fd_other_total_amount: 100,
    fd_717d1bac33942d4b88eca9: 0,
    fd_train: 0,
    fd_train_tax: 0,
    fd_train_num: 2,
    fd_taxi: 0,
    fd_person_name: "张三",
    fd_airplane_amount: 0,
    fd_total_cost: 100,
    fd_pay_bank_select: "1002200354"
  };
  const baseTables = {
    fd_project_num_list: [{ fd_bseg_projk: "W1" }, { fd_bseg_projk: "W2" }],
    fd_payee_list: [
      { fd_payee_amount: 60, fd_payee_name: "甲", fd_card_number: "C1" },
      { fd_payee_amount: 40, fd_payee_name: "乙", fd_card_number: "C2" }
    ]
  };

  const wbsRows = executeFinanceAction(action, baseValues, baseTables);
  assert.deepEqual(wbsRows.map((row) => [row.fd_account_no, row.fd_amount, row.fd_wbs]), [
    ["40", "50.00", "W1"],
    ["40", 50, "W2"],
    ["50", "-60.00", ""],
    ["50", "-40.00", ""]
  ]);
  assert.deepEqual(wbsRows.slice(-2).map((row) => [row.fd_z_payee, row.fd_oa_accnt]), [
    ["甲", "C1"],
    ["乙", "C2"]
  ]);

  const noWbsRows = executeFinanceAction(action, { ...baseValues, fd_has_project: 0 }, baseTables);
  assert.deepEqual(noWbsRows.slice(0, 1).map((row) => [row.fd_amount, row.fd_wbs]), [["100.00", ""]]);

  const cityRows = executeFinanceAction(action, {
    ...baseValues,
    fd_3cc1757848e700: 0,
    fd_other_total_amount: 0,
    fd_717d1bac33942d4b88eca9: 30,
    fd_total_cost: 30
  }, baseTables);
  assert.equal(cityRows[0].fd_category_name, "差旅费-市内-市内交通费");

  const domesticRows = executeFinanceAction(action, {
    ...baseValues,
    fd_other_total_amount: 0,
    fd_717d1bac33942d4b88eca9: 30,
    fd_train: 20,
    fd_train_tax: 3,
    fd_total_cost: 30,
    fd_pay_bank_select: "1002000033"
  }, baseTables);
  assert.ok(domesticRows.some((row) => row.fd_course === "2221010148" && row.fd_amount === "3.00"));
  assert.ok(domesticRows.slice(-2).every((row) => row.fd_course === "1002000033"));
}

function executeFinanceAction(action, values, tables) {
  const physicalByLogical = {};
  const executable = action.function.replace(/\$\{table:([^}]+)\}/gu, (_match, tableId) => {
    physicalByLogical[tableId] = `physical_${tableId}`;
    return physicalByLogical[tableId];
  });
  const logicalByPhysical = Object.fromEntries(
    Object.entries(physicalByLogical).map(([logical, physical]) => [physical, logical])
  );
  let output = [];
  const onClick = Function("MKXFORM", `${executable}; return onClick;`)({
    getValue(id) {
      const logicalTable = logicalByPhysical[id];
      return logicalTable ? { values: tables[logicalTable] || [] } : values[id];
    },
    getValueText() { return ""; },
    setValue(id, value) { values[id] = value; },
    setDetailValues(_id, rows) { output = rows; }
  });
  onClick();
  return output;
}

function assertMappedActions(actions, sourceRef, expected, basis) {
  const sourceActions = actions.filter((action) =>
    action.sourceRefs.includes(sourceRef) && action.functionMappings?.[0]?.basis === basis
  );
  assert.deepEqual(
    sourceActions.filter((action) => action.event === "onChange").map((action) => action.controlId),
    expected.onChange
  );
  assert.deepEqual(
    sourceActions.filter((action) => action.scope === "global").map((action) => action.event),
    expected.global
  );
  for (const action of sourceActions) {
    assert.doesNotMatch(action.function, /DocList_TableInfo|GetXFormSameRowFieldById|jQuery|\$\(/);
  }
}

function actionsByBasis(actions, basis) {
  return actions.filter(action => action.functionMappings?.[0]?.basis === basis);
}

function actionKey(action) {
  return `${action.event}:${action.controlId || ""}:${action.tableId || ""}`;
}

function assertMappedDetailActions(actions, sourceRef, tableId, controlIds) {
  const sourceActions = actions.filter((action) => action.sourceRefs.includes(sourceRef));
  assert.deepEqual(sourceActions.map((action) => action.controlId), controlIds);
  for (const action of sourceActions) {
    assert.equal(action.tableId, tableId);
    assert.equal(action.event, "onChange");
    assert.match(action.function, new RegExp(`\\$\\{table:${tableId}\\}`));
    assert.doesNotMatch(action.function, /GetXFormSameRowFieldById|new Map|jQuery|\$\(/);
  }
}
