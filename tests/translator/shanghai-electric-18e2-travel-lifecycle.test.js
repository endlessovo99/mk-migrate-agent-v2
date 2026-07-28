import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inspectDeterministicScriptBranchProof
} from "../../src/dsl/deterministic-script-translations.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import {
  travelReimbursementLifecycleCandidates
} from "../../src/translator/travel-reimbursement-lifecycle.js";
import {
  draftMkScriptsFromSourceScripts
} from "../../src/translator/sysform-jsp-scripts.js";

const sourcePath = "tests/fixtures/source/18e2b225a8abe4503405e6e4bb88aba0";
const lifecycleBasis = "deterministic-travel-reimbursement-lifecycle";
const submitBasis = "deterministic-travel-reimbursement-submit-calculation";
const lifecycleSourceId = "fd_3cc17629476baa.script.2";
let fixture;

describe("Shanghai Electric 18e2 travel lifecycle", () => {
  it("closes the travel mode, department, load, and submit lifecycle deterministically", () => {
    const { dsl } = fixtureArtifacts();
    const byId = (id) => dsl.scripts.actions.find((action) => action.id === id);
    const lifecycleIds = [
      "fd_3e48c1f17e7e42.script.1.event.1",
      "fd_3ba9eae4151422.script.1.event.1",
      "fd_3cc17629476baa.script.1.event.1",
      "fd_3cc17629476baa.script.2.event.1",
      "fd_3cc17629476baa.script.2.event.2",
      "fd_3cc17629476baa.script.2.event.3",
      "fd_3cc17629476baa.script.2.event.4",
      "fd_3d19de502071ba.script.1.event.1"
    ];

    for (const id of lifecycleIds) {
      const action = byId(id);
      assert.ok(action, id);
      assert.equal(action.translationStatus, "mapped", id);
      assert.deepEqual(action.coverage.residuals, [], id);
      assert.ok(
        [lifecycleBasis, submitBasis].includes(action.functionMappings[0]?.basis),
        id
      );
      assert.equal(
        inspectDeterministicScriptBranchProof(action, {
          calculationDecisions: dsl.scripts.calculationDecisions
        }).ok,
        true,
        id
      );
    }

    const city = byId("fd_3cc17629476baa.script.2.event.1");
    assert.deepEqual(city.coverage.nativeRules, [
      "linkage.fd_3cc1757848e700.eq.1"
    ]);
    assert.doesNotMatch(city.function, /MKXFORM\.setFieldAttr/);
    assert.match(city.function, /MKXFORM\.setValue\("fd_the_city_flag", "1"\)/);
    for (const tableId of [
      "fd_trafficCity_detail",
      "fd_train_detail",
      "fd_flight_detail"
    ]) {
      assert.match(
        city.function,
        new RegExp(`MKXFORM\\.setDetailValues\\("\\$\\{table:${tableId}\\}", \\[\\{\\}\\]\\)`)
      );
    }
    const cityAllowance = actionsByBasis(
      dsl,
      "deterministic-allowance-calculation"
    ).find((action) =>
      action.controlId === "fd_3cc1757848e700" &&
      action.semanticHints.coveredCalculationRanges.some((range) =>
        range.name === "trafficCityChange"
      )
    );
    assert.ok(cityAllowance);
    assert.equal(cityAllowance.translationStatus, "mapped");
    assert.deepEqual(cityAllowance.coverage.residuals, []);
    assert.equal(
      inspectDeterministicScriptBranchProof(cityAllowance, {
        calculationDecisions: dsl.scripts.calculationDecisions
      }).ok,
      true
    );

    assertCostCenterBehavior(
      byId("fd_3ba9eae4151422.script.1.event.1"),
      byId("fd_3cc17629476baa.script.2.event.2")
    );
    assertLoadBehavior(byId("fd_3cc17629476baa.script.2.event.3"));
    assertSubmitBehavior(byId("fd_3cc17629476baa.script.2.event.4"));
    assertNativePayeeCalculations(dsl);

    const financeConstant = byId("fd_3d19de502071ba.script.1.event.1");
    assert.equal(financeConstant.semanticHints.compileTimeConstants.theFinanceFlag, 1);
    assert.equal(
      financeConstant.semanticHints.compileTimeConsumers.includes(
        "fd_3cc17629476baa.script.2.event.4"
      ),
      true
    );
  });

  it("fails closed when source deterministic lifecycle semantics drift", () => {
    const { source, dsl } = fixtureArtifacts();
    const mutations = [
      {
        label: "card-number minimum length",
        sourceId: lifecycleSourceId,
        from: "tempPayeeList[i].length < 16",
        to: "tempPayeeList[i].length < 15"
      },
      {
        label: "payee-difference comparison",
        sourceId: lifecycleSourceId,
        from: "Number($tempObj.val()) != 0",
        to: "Number($tempObj.val()) > 0"
      },
      {
        label: "finance save-marker assignment",
        sourceId: lifecycleSourceId,
        from: "theFlagNo = theConstFiaSaveFlag;",
        to: "theFlagNo = theConstFiaSaveFlag + 1;"
      },
      {
        label: "payee total refresh call",
        sourceId: lifecycleSourceId,
        from: "payeeListSum();",
        to: "/* payeeListSum removed */"
      },
      {
        label: "finance save-marker constant",
        sourceId: "fd_3cc17629476baa.script.1",
        from: "theConstFiaSaveFlag = 2222",
        to: "theConstFiaSaveFlag = 3333"
      },
      {
        label: "initial city flag constant",
        sourceId: "fd_3cc17629476baa.script.1",
        from: "theCityFlag = 1",
        to: "theCityFlag = 2"
      },
      {
        label: "initial save counter constant",
        sourceId: "fd_3cc17629476baa.script.1",
        from: "theFlagNo = 0",
        to: "theFlagNo = 9"
      },
      {
        label: "city-mode domestic branch value",
        sourceId: lifecycleSourceId,
        from: "if(value == \"1\"){",
        to: "if(value == \"2\"){"
      },
      {
        label: "city-mode global flag assignment",
        sourceId: lifecycleSourceId,
        from: "theCityFlag = 1;",
        to: "theCityFlag = 2;"
      },
      {
        label: "second cost-center unconditional reset",
        sourceId: "fd_3ba9eae4151422.script.1",
        from: "secondCostCenter.empty();",
        to: "/* secondCostCenter.empty removed */"
      },
      {
        label: "payee aggregate iterative rounding",
        sourceId: "fd_3cc25d96ee0df2.script.1",
        from: "sum = theFixedNumTwo(sum + Number(current_inspire));",
        to: "sum = sum + Number(current_inspire);"
      },
      {
        label: "two-decimal rounding helper",
        sourceId: "fd_3cd39a8bc880b0.script.1",
        from: "var precision = 2;",
        to: "var precision = 3;"
      },
      {
        label: "domestic allowance rate",
        sourceId: "fd_3bc187ead08638.script.1",
        from: "everydayAllowance.val(100);",
        to: "everydayAllowance.val(90);"
      },
      {
        label: "allowance mode source field",
        sourceId: lifecycleSourceId,
        from: "theCityFlag = Number(getFormRadioValue('fd_3cc1757848e700'));",
        to: "theCityFlag = Number(getFormRadioValue('fd_other_mode'));"
      }
    ];

    for (const mutation of mutations) {
      const mutated = mutateSourceScript(source, mutation);
      const lifecycleSource = mutated.scripts.sources.find(
        (candidate) => candidate.id === lifecycleSourceId
      );
      const candidates = travelReimbursementLifecycleCandidates(lifecycleSource, {
        sourceScripts: mutated.scripts,
        form: dsl.form,
        formRules: dsl.formRules
      });
      assert.deepEqual(candidates, [], mutation.label);
    }

    const drifted = mutateSourceScript(source, mutations[0]);
    const driftedScripts = draftMkScriptsFromSourceScripts(drifted.scripts, {
      form: dsl.form,
      formRules: dsl.formRules
    });
    const driftedSubmit = driftedScripts.actions.find(
      (action) => action.id === `${lifecycleSourceId}.event.4`
    );
    assert.equal(driftedSubmit.translationStatus, "needs_review");
    assert.equal(
      driftedSubmit.functionMappings.some(
        (mapping) => mapping.basis === submitBasis
      ),
      false
    );

    const cacheProbe = structuredClone(source);
    const cachedLifecycle = cacheProbe.scripts.sources.find(
      (candidate) => candidate.id === lifecycleSourceId
    );
    const candidateOptions = {
      sourceScripts: cacheProbe.scripts,
      form: dsl.form,
      formRules: dsl.formRules
    };
    assert.equal(
      travelReimbursementLifecycleCandidates(
        cachedLifecycle,
        candidateOptions
      ).length,
      4
    );
    cachedLifecycle.javascript = cachedLifecycle.javascript.replace(
      "tempPayeeList[i].length < 16",
      "tempPayeeList[i].length < 15"
    );
    assert.deepEqual(
      travelReimbursementLifecycleCandidates(
        cachedLifecycle,
        candidateOptions
      ),
      [],
      "in-place source mutation invalidates the cached model"
    );
  });
});

function assertCostCenterBehavior(firstCostCenterAction, departmentAction) {
  const firstRuntime = createRuntime({
    fd_bseg_firstkostl: "4",
    fd_bseg_kostl: "221710013"
  });
  compile(firstCostCenterAction, firstRuntime.api)("4");
  assert.deepEqual(firstRuntime.props.at(-1), {
    id: "fd_bseg_kostl",
    props: {
      options: [
        { label: "采购部（采购业务）", value: "221710013" },
        { label: "采购部（物流业务）", value: "221730001" }
      ]
    }
  });
  assert.equal(firstRuntime.values.fd_bseg_kostl, "");

  firstRuntime.values.fd_bseg_firstkostl = "3";
  compile(firstCostCenterAction, firstRuntime.api)("3");
  assert.deepEqual(firstRuntime.props.at(-1).props.options, [
    { label: "财务部", value: "221710002" }
  ]);
  assert.equal(firstRuntime.values.fd_bseg_kostl, "");

  const departmentRuntime = createRuntime({
    fd_bseg_firstkostl: "",
    fd_bseg_kostl: "221710002"
  });
  compile(departmentAction, departmentRuntime.api)(["department-id", "采购部"]);
  assert.equal(departmentRuntime.values.fd_bseg_firstkostl, "4");
  assert.deepEqual(departmentRuntime.props.at(-1).props.options, [
    { label: "采购部（采购业务）", value: "221710013" },
    { label: "采购部（物流业务）", value: "221730001" }
  ]);
  assert.equal(departmentRuntime.values.fd_bseg_kostl, "");
}

function assertLoadBehavior(action) {
  const runtime = createRuntime({
    fd_3cc1757848e700: "0",
    fd_396238f4339462: ["department-id", "采购部"],
    fd_bseg_firstkostl: "",
    fd_bseg_kostl: ""
  });
  compile(action, runtime.api)();
  assert.deepEqual(runtime.attrs, [
    { id: "fd_guonei_row", value: 4 },
    { id: "fd_guonei_row", value: 6 }
  ]);
  assert.equal(runtime.values.fd_bseg_firstkostl, "4");
  assert.equal(runtime.setValues.some(({ id }) =>
    ["fd_voucher_no", "fd_voucher_msg", "fd_link_address"].includes(id)
  ), false);
  assert.equal(runtime.detailValues.some(({ id }) =>
    id === "${table:fd_finance_detail}"
  ), false);
}

function assertSubmitBehavior(action) {
  const draft = createRuntime({});
  assert.equal(compile(action, draft.api)({ isDraft: true }), true);
  assert.deepEqual(draft.setValues, []);

  const valid = createRuntime({
    fd_is_project: "1",
    "${table:fd_project_num_list}": [
      { fd_bseg_projk: "Z-2217WCCGT059-J" }
    ],
    "${table:fd_payee_list}": [
      { fd_card_number: "1234567890123456", fd_payee_amount: 0.105 },
      { fd_card_number: "12345678901234567", fd_payee_amount: 0.105 }
    ],
    fd_total_cost: 0.22,
    fd_payee_total: -1,
    fd_payee_diff: 999,
    fd_flag_save_no: 7
  });
  assert.equal(compile(action, valid.api)({ isDraft: false }), true);
  assert.equal(valid.values.fd_payee_total, 0.22);
  assert.equal(valid.values.fd_payee_diff, 0);
  assert.equal(valid.values.fd_flag_save_no, 2222);
  assert.deepEqual(valid.messages, []);

  const invalidWbs = createRuntime({
    fd_is_project: "1",
    "${table:fd_project_num_list}": [{ fd_bseg_projk: "NOT-IN-WBS-POOL" }],
    "${table:fd_payee_list}": [],
    fd_payee_diff: 0
  });
  assert.equal(compile(action, invalidWbs.api)({}), false);
  assert.match(invalidWbs.messages[0], /项目\/令号不存在/);

  const invalidCard = createRuntime({
    fd_is_project: "0",
    "${table:fd_project_num_list}": [],
    "${table:fd_payee_list}": [{ fd_card_number: "123" }],
    fd_payee_diff: 0
  });
  assert.equal(compile(action, invalidCard.api)({}), false);
  assert.match(invalidCard.messages[0], /卡号位数不满足16-19位/);

  const invalidDiff = createRuntime({
    fd_is_project: "0",
    "${table:fd_project_num_list}": [],
    "${table:fd_payee_list}": [
      { fd_card_number: "1234567890123456", fd_payee_amount: 9 }
    ],
    fd_total_cost: 8,
    fd_payee_total: 9,
    fd_payee_diff: 0
  });
  assert.equal(compile(action, invalidDiff.api)({}), false);
  assert.match(invalidDiff.messages[0], /收款金额与费用总计差额/);
}

function assertNativePayeeCalculations(dsl) {
  const field = (id) => dsl.form.fields.find((candidate) => candidate.id === id);
  assert.equal(field("fd_payee_total").componentId, "xform-calculate");
  assert.deepEqual(field("fd_payee_total").props.calculation, {
    kind: "aggregate",
    operation: "sum",
    tableId: "fd_payee_list",
    fieldId: "fd_payee_amount"
  });
  assert.equal(field("fd_payee_diff").componentId, "xform-calculate");
  assert.deepEqual(field("fd_payee_diff").props.calculation, {
    kind: "formula",
    expression: "$fd_payee_total$ - $fd_total_cost$",
    displayExpression: "$fd_payee_total$ - $fd_total_cost$",
    fieldIds: ["fd_payee_total", "fd_total_cost"]
  });
}

function fixtureArtifacts() {
  if (!fixture) {
    const source = cleanSourceFile(sourcePath);
    fixture = {
      source,
      dsl: draftSourceDraft(source)
    };
  }
  return fixture;
}

function mutateSourceScript(source, mutation) {
  const mutated = structuredClone(source);
  const target = mutated.scripts.sources.find(
    (candidate) => candidate.id === mutation.sourceId
  );
  assert.ok(target, mutation.label);
  assert.equal(target.javascript.includes(mutation.from), true, mutation.label);
  target.javascript = target.javascript.replace(mutation.from, mutation.to);
  return mutated;
}

function createRuntime(initialValues) {
  const values = structuredClone(initialValues);
  const setValues = [];
  const detailValues = [];
  const props = [];
  const attrs = [];
  const messages = [];
  return {
    values,
    setValues,
    detailValues,
    props,
    attrs,
    messages,
    api: {
      getValue(id) {
        return values[id];
      },
      setValue(id, value) {
        values[id] = value;
        setValues.push({ id, value });
      },
      setDetailValues(id, value) {
        values[id] = value;
        detailValues.push({ id, value });
      },
      setProps(id, value) {
        props.push({ id, props: value });
      },
      setFieldAttr(id, value) {
        attrs.push({ id, value });
      },
      toast(message) {
        messages.push(message);
      }
    }
  };
}

function compile(action, MKXFORM) {
  return Function(
    "MKXFORM",
    `"use strict";\n${action.function}\nreturn ${action.name};`
  )(MKXFORM);
}

function actionsByBasis(dsl, basis) {
  return dsl.scripts.actions.filter((action) =>
    action.functionMappings.some((mapping) => mapping.basis === basis)
  );
}
