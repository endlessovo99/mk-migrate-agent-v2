import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { conditionalTotalCalculationModel } from "../../src/translator/conditional-total-calculation.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/calculation-script-recipes/route-calculation-script-recipes_SysFormTemplate.xml";

describe("calculation script recipes Route case", () => {
  it("maps structurally evidenced allowance, date, receipt-cap, load, and submit recalculation", () => {
    const dsl = stages();
    const actions = actionsByBasis(dsl, "deterministic-allowance-calculation");
    const receiptAmount = dsl.form.fields
      .find(field => field.id === "fd_receipts")
      .columns.find(column => column.id === "fd_receipt_value");

    assert.equal(receiptAmount.type, "number");
    assert.equal(receiptAmount.componentId, "xform-number");
    assert.equal(receiptAmount.sourceProps.numericCalculationInference.classification, "source");
    assert.equal(actions.length, 11);
    const coveredNames = new Set(actions[0].semanticHints.coveredCalculationRanges.map(range => range.name));
    assert.equal(coveredNames.has("receiptDetail"), true);
    assert.equal(coveredNames.has("receiptTotal"), true);
    assert.equal(coveredNames.has("unsafeReceiptDetail"), false);
    assert.equal(coveredNames.has("unsafeReceiptTotal"), false);
    assert.equal(coveredNames.has("reversedReceiptDetail"), false);
    assert.equal(coveredNames.has("reversedReceiptTotal"), false);
    assert.equal(coveredNames.has("unseparatedReceiptDetail"), false);
    assert.equal(coveredNames.has("unseparatedReceiptTotal"), false);
    assert.equal(coveredNames.has("outOfOrderReceiptDetail"), false);
    assert.equal(coveredNames.has("outOfOrderReceiptTotal"), false);
    assert.equal(coveredNames.has("partialReceiptDetail"), false);
    assert.equal(coveredNames.has("partialReceiptTotal"), false);
    assert.equal(coveredNames.has("filteredReceiptDetail"), false);
    assert.equal(coveredNames.has("filteredReceiptTotal"), false);
    assert.ok(dsl.scripts.calculationDecisions.some(decision =>
      decision.id === "calculation.manual.source.form.jsp.jsp_allowance_recipe.script.1" &&
      decision.targetRefs.includes("fd_receipt_result")
    ));
    assert.deepEqual(actions.map(actionKey), [
      "onChange:fd_trip_start:",
      "onChange:fd_trip_end:",
      "onChange:fd_people:",
      "onChange:fd_package_mode:",
      "onChange:fd_regular_allowance:",
      "onChange:fd_package_allowance:",
      "onChange:fd_radiation_allowance:",
      "onChange:fd_receipt_value:fd_receipts",
      "onChange:fd_trip_mode:",
      "onLoad::",
      "onBeforeSubmit::"
    ]);
    for (const action of actions) {
      assert.equal(action.translationStatus, "mapped");
      assert.match(action.function, /MKXFORM\.getValue\("fd_trip_mode"\)/);
      assert.match(action.function, /MKXFORM\.getValue\("\$\{table:fd_receipts\}"\)/);
      assert.match(action.function, /Math\.min\(receiptTotal, Math\.max\(receiptCap, 0\)\)/);
      assert.doesNotMatch(action.function, /jQuery|\$\(|DocList_TableInfo|getFormRadioValue/);
    }
    const submit = actions.find(action => action.event === "onBeforeSubmit");
    assert.match(submit.function, /context && context\.isDraft/);
    assert.match(submit.function, /return true/);
  });

  it("maps a date-versioned detail-row lookup without Map or legacy DOM access", () => {
    const dsl = stages();
    const actions = actionsByBasis(dsl, "deterministic-detail-lookup-calculation");

    assert.deepEqual(actions.map(actionKey), [
      "onChange:fd_destination:fd_lookup_lines",
      "onChange:fd_paid:fd_lookup_lines"
    ]);
    for (const action of actions) {
      assert.equal(action.translationStatus, "mapped");
      assert.match(action.function, /var currentRates = \{"A":1000,"B":800\}/);
      assert.match(action.function, /var previousRates = \{"A":900,"B":700\}/);
      assert.match(action.function, /MKXFORM\.updateControl\("\$\{table:fd_lookup_lines\}\.fd_reward", rowNum/);
      assert.doesNotMatch(action.function, /new Map|GetXFormSameRowFieldById|jQuery|\$\(/);
    }
  });

  it("maps grouped detail totals, counts, mode branches, rounding, tax, and post-delete recalculation", () => {
    const dsl = stages();
    const actions = actionsByBasis(dsl, "deterministic-grouped-detail-calculation");

    assert.deepEqual(actions.map(actionKey), [
      "onChange:fd_receipt_kind:fd_receipts",
      "onChange:fd_receipt_value:fd_receipts",
      "onChange:fd_receipt_result:",
      "onChange:fd_trip_mode:",
      "onAfterDel:fd_receipts:fd_receipts",
      "onLoad::",
      "onBeforeSubmit::"
    ]);
    for (const action of actions) {
      assert.equal(action.translationStatus, "mapped");
      if (action.event === "onAfterDel") {
        assert.match(action.function, /var rawRows = data \|\| \[\]/);
      } else {
        assert.match(action.function, /MKXFORM\.getValue\("\$\{table:fd_receipts\}"\)/);
      }
      assert.match(action.function, /category === "beta"/);
      assert.match(action.function, /MKXFORM\.setValue\("fd_group_count", groupedCount\)/);
      assert.match(action.function, /taxableAmount \/ 1\.09 \* 0\.09/);
      assert.doesNotMatch(action.function, /DocList_TableInfo|SetXFormFieldValueById|jQuery|\$\(/);
    }
    assert.equal(dsl.scripts.calculationDecisions.some(decision =>
      decision.code === "calculation.detail_row_delete_immediate_recalc_unverified"
    ), false);
    const afterDelete = actions.find(action => action.event === "onAfterDel");
    assert.match(afterDelete.function, /function onAfterDel\(data\)/);
    assert.match(afterDelete.function, /var rawRows = data \|\| \[\]/);
  });

  it("maps traveler text splitting, description composition, and explicit cross-calculation calls", () => {
    const dsl = stages();
    const actions = actionsByBasis(dsl, "deterministic-person-text-calculation");

    assert.deepEqual(actions.map(actionKey), [
      "onChange:fd_traveler_text:",
      "onChange:fd_destination_text:",
      "onChange:fd_reason_text:",
      "onLoad::"
    ]);
    const traveler = actions[0];
    assert.equal(traveler.translationStatus, "mapped");
    assert.match(traveler.function, /replace\(\/，\/g, "、"\)/);
    assert.match(traveler.function, /replace\(\/\\\\\/g, "、"\)/);
    assert.match(traveler.function, /if \(peopleCount > 0\)/);
    assert.match(traveler.function, /MKXFORM\.setValue\("fd_people", peopleCount\)/);
    assert.match(traveler.function, /MKXFORM\.setValue\("fd_description_text", description\)/);
    assert.match(traveler.function, /MKXFORM\.getValue\("fd_trip_mode"\)/);
    assert.match(traveler.function, /Math\.min\(receiptTotal, Math\.max\(receiptCap, 0\)\)/);
    assert.doesNotMatch(traveler.function, /jQuery|\$\(|SetXFormFieldValueById|getFormFieldValue/);

    for (const action of actions.slice(1)) {
      assert.equal(action.translationStatus, "mapped");
      assert.match(action.function, /MKXFORM\.setValue\("fd_description_text", description\)/);
      assert.doesNotMatch(action.function, /jQuery|\$\(|SetXFormFieldValueById|getFormFieldValue/);
    }
  });

  it("maps a travel-scope total as a native conditional formula and uppercase currency as synchronous actions", () => {
    const dsl = stages();
    const total = dsl.form.fields.find(field => field.id === "fd_grand_total");
    const actions = actionsByBasis(dsl, "deterministic-conditional-total-uppercase");

    assert.equal(total.componentId, "xform-calculate");
    assert.deepEqual(total.props.calculation, {
      kind: "formula",
      expression: "Math.round((($fd_trip_mode$ == 0 ? ($fd_local_transport_cost$ + $fd_allowance_cost$ + $fd_hotel_cost$ + $fd_other_cost$) : ($fd_local_transport_cost$ + $fd_allowance_cost$ + $fd_hotel_cost$ + $fd_other_cost$ + $fd_incentive_cost$))) * 100) / 100",
      displayExpression: "travel-scope conditional total",
      fieldIds: [
        "fd_trip_mode",
        "fd_local_transport_cost",
        "fd_allowance_cost",
        "fd_hotel_cost",
        "fd_other_cost",
        "fd_incentive_cost"
      ]
    });
    assert.deepEqual(actions.map(actionKey), [
      "onChange:fd_trip_mode:",
      "onChange:fd_local_transport_cost:",
      "onChange:fd_allowance_cost:",
      "onChange:fd_hotel_cost:",
      "onChange:fd_other_cost:",
      "onChange:fd_incentive_cost:",
      "onChange:fd_grand_total:",
      "onLoad::",
      "onBeforeSubmit::"
    ]);
    for (const action of actions) {
      assert.equal(action.translationStatus, "mapped");
      assert.match(action.function, /var cnDigits = \["零","壹","贰","叁","肆","伍","陆","柒","捌","玖"\]/);
      assert.match(action.function, /MKXFORM\.setValue\("fd_grand_total_upper", chineseAmount\)/);
      assert.doesNotMatch(action.function, /XForm_GetChinaValue|jQuery|\$\(/);
    }
    const submit = actions.find(action => action.event === "onBeforeSubmit");
    assert.match(submit.function, /return true/);

    const values = {
      fd_trip_mode: 0,
      fd_local_transport_cost: 1.01,
      fd_allowance_cost: 0,
      fd_hotel_cost: 0,
      fd_other_cost: 0,
      fd_incentive_cost: 0,
      fd_grand_total: 1.01
    };
    const onChange = Function("MKXFORM", `${actions[0].function}; return onChange;`)({
      getValue(id) { return values[id]; },
      setValue(id, value) { values[id] = value; }
    });
    onChange();
    assert.equal(values.fd_grand_total_upper, "壹元零壹分");

    values.fd_local_transport_cost = 0.01;
    values.fd_grand_total = 0.01;
    onChange();
    assert.equal(values.fd_grand_total_upper, "零元零壹分");

    values.fd_local_transport_cost = 0.10;
    values.fd_grand_total = 0.10;
    onChange();
    assert.equal(values.fd_grand_total_upper, "零元壹角");

    assert.ok(dsl.scripts.calculationDecisions.some(decision =>
      decision.classification === "manual" &&
      decision.sourceRefs.includes("source.form.jsp.jsp_conditional_total_recipe.script.1") &&
      decision.targetRefs.includes("fd_description_text")
    ));
    assert.equal(actions.some(action =>
      action.sourceRefs.includes("source.form.jsp.jsp_unsafe_conditional_branch.script.1")
    ), false);
    assert.ok(dsl.scripts.calculationDecisions.some(decision =>
      decision.classification === "manual" &&
      decision.sourceRefs.includes("source.form.jsp.jsp_unsafe_conditional_branch.script.1") &&
      decision.targetRefs.includes("fd_description_text")
    ));
    assert.equal(actions.some(action =>
      action.sourceRefs.includes("source.form.jsp.jsp_unsafe_conditional_order.script.1")
    ), false);
    assert.ok(dsl.scripts.calculationDecisions.some(decision =>
      decision.classification === "manual" &&
      decision.sourceRefs.includes("source.form.jsp.jsp_unsafe_conditional_order.script.1") &&
      decision.targetRefs.includes("fd_grand_total")
    ));
    assert.equal(actions.some(action =>
      action.sourceRefs.includes("source.form.jsp.jsp_unsafe_conditional_mutation.script.1")
    ), false);
    assert.ok(dsl.scripts.calculationDecisions.some(decision =>
      decision.classification === "manual" &&
      decision.sourceRefs.includes("source.form.jsp.jsp_unsafe_conditional_mutation.script.1") &&
      decision.targetRefs.includes("fd_grand_total")
    ));
  });

  it("fails closed when the same conditional mode variable binds different source fields", () => {
    const source = cleanSourceFile(fixture);
    const conditionalSource = source.scripts.sources.find(candidate =>
      candidate.sourceRef === "source.form.jsp.jsp_conditional_total_recipe.script.1"
    );
    assert.ok(conditionalTotalCalculationModel(conditionalSource, source.scripts));
    assert.equal(conditionalTotalCalculationModel(conditionalSource, {
      sources: [...source.scripts.sources, {
        sourceRef: "source.form.jsp.jsp_conflicting_mode_binding.script.1",
        javascript: "var fixtureTravelScope = Number(getFormRadioValue('fd_receipt_kind'));"
      }]
    }), undefined);
    const commentedSources = source.scripts.sources.map(candidate => ({
      ...candidate,
      javascript: String(candidate.javascript || "").replace(
        "var fixtureTravelScope = Number(getFormRadioValue(\"fd_trip_mode\"));",
        "// var fixtureTravelScope = Number(getFormRadioValue(\"fd_trip_mode\"));"
      )
    }));
    const commentedConditional = commentedSources.find(candidate =>
      candidate.sourceRef === conditionalSource.sourceRef
    );
    assert.equal(conditionalTotalCalculationModel(commentedConditional, {
      sources: commentedSources
    }), undefined, "commented mode bindings must not become native dependencies");
  });

  it("persists every mapped event and its detail physical-table binding through readback", async () => {
    const result = await runRouteCase("calculation-script-recipes-success");
    const expected = result.dsl.scripts.actions.filter(action => action.translationStatus === "mapped");
    const observed = result.execution.readback.form.scripts.actions;
    const physicalTableByLogicalId = new Map();

    assert.equal(observed.length, expected.length);
    for (const expectedAction of expected) {
      const controlSuffix = expectedAction.controlId ? `.${expectedAction.controlId}` : undefined;
      const actual = observed.find(action => action.id === expectedAction.id) || observed.find(action =>
        action.event === expectedAction.event &&
        (controlSuffix ? action.controlKey?.endsWith(controlSuffix) : !action.controlKey)
      );
      assert.ok(actual, `${expectedAction.event}:${expectedAction.controlId || "global"} must survive readback`);
      assert.equal(actual.hasCanonicalGuard, true);
      if (expectedAction.tableId) {
        const physicalTable = actual.controlKey.slice(0, actual.controlKey.lastIndexOf("."));
        assert.notEqual(physicalTable, expectedAction.tableId);
        assert.notEqual(physicalTable, "route_model_generated");
        const prior = physicalTableByLogicalId.get(expectedAction.tableId);
        if (prior) assert.equal(physicalTable, prior);
        physicalTableByLogicalId.set(expectedAction.tableId, physicalTable);
      }
    }
    assert.notEqual(
      physicalTableByLogicalId.get("fd_receipts"),
      physicalTableByLogicalId.get("fd_lookup_lines")
    );

    const prepared = prepareSample(result.dsl);
    const mutated = structuredClone(prepared.update);
    const config = xformConfig(mutated);
    const receiptModel = config.dataModel.find(model =>
      model.dynamicProps?.detailFieldName === "fd_receipts"
    );
    const formAttr = JSON.parse(config.attribute.formAttr);
    const detailActionKey = `${receiptModel.fdTableName}.${receiptModel.fdTableName}`;
    assert.ok(formAttr.controlAction.control[detailActionKey].onAfterDel);
    delete formAttr.controlAction.control[detailActionKey].onAfterDel;
    config.attribute.formAttr = JSON.stringify(formAttr);
    mutated.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);

    const mutationReadback = prepared.verify(mutated);
    assert.equal(mutationReadback.ok, false);
    assert.equal(mutationReadback.diagnostics.some(diagnostic =>
      diagnostic.code === "readback.scripts.action_missing"
    ), true);

    const relocated = structuredClone(prepared.update);
    const relocatedConfig = xformConfig(relocated);
    const relocatedReceiptModel = relocatedConfig.dataModel.find(model =>
      model.dynamicProps?.detailFieldName === "fd_receipts"
    );
    const relocatedAttr = JSON.parse(relocatedConfig.attribute.formAttr);
    const relocatedDetailKey = `${relocatedReceiptModel.fdTableName}.${relocatedReceiptModel.fdTableName}`;
    const [relocatedAction] = relocatedAttr.controlAction.control[relocatedDetailKey].onAfterDel;
    delete relocatedAttr.controlAction.control[relocatedDetailKey].onAfterDel;
    const wrongControlKey = "mk_model_test.fd_receipt_result";
    relocatedAttr.controlAction.control[wrongControlKey] ||= {};
    relocatedAttr.controlAction.control[wrongControlKey].onAfterDel = [relocatedAction];
    relocatedConfig.attribute.formAttr = JSON.stringify(relocatedAttr);
    relocated.mechanisms["sys-xform"].fdConfig = JSON.stringify(relocatedConfig);

    const relocatedReadback = prepared.verify(relocated);
    assert.equal(relocatedReadback.ok, false);
    assert.equal(relocatedReadback.diagnostics.some(diagnostic =>
      diagnostic.code === "readback.scripts.binding_mismatch"
    ), true);
  });
});

function stages() {
  return draftSourceDraft(cleanSourceFile(fixture));
}

function actionsByBasis(dsl, basis) {
  return (dsl.scripts?.actions || []).filter(action => action.functionMappings?.[0]?.basis === basis);
}

function actionKey(action) {
  return `${action.event}:${action.controlId || ""}:${action.tableId || ""}`;
}
