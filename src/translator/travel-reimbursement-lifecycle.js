import { inlineOnChangeSourceActionKey } from "./source-action-key.js";
import { DETAIL_TABLE_IDS, FIELD_IDS, SOURCE_IDS } from "./travel-reimbursement-lifecycle-contract.js";
import {
  buildCityModeOnChange,
  buildCostCenterOnChange,
  buildDepartmentOnChange,
  buildLifecycleOnLoad,
  buildSubmit
} from "./travel-reimbursement-lifecycle-codegen.js";
import {
  getTravelReimbursementLifecycleModel
} from "./travel-reimbursement-lifecycle-model.js";

export const TRAVEL_REIMBURSEMENT_LIFECYCLE_BASIS =
  "deterministic-travel-reimbursement-lifecycle";
export const TRAVEL_REIMBURSEMENT_SUBMIT_BASIS =
  "deterministic-travel-reimbursement-submit-calculation";

export function travelReimbursementLifecycleCandidates(source, options = {}) {
  if (!Object.values(SOURCE_IDS).includes(source?.id)) return [];
  const model = getTravelReimbursementLifecycleModel(
    options.sourceScripts,
    options.form,
    options.formRules
  );
  if (!model) return [];

  if (source.id === SOURCE_IDS.wbs) {
    return [compileTimeConstantCandidate({
      source,
      range: model.ranges.wbs,
      constants: {
        commonWBSStrSha256Evidence: `${model.commonWbs.length}-character-static-pool`,
        commonKYWBSStrUnused: true
      },
      consumers: [`${SOURCE_IDS.lifecycle}.event.4`],
      sourceDescription: "commonWBSStr and unused commonKYWBSStr declarations",
      targetDescription: "commonWBSStr is inlined into deterministic onBeforeSubmit validation"
    })];
  }

  if (source.id === SOURCE_IDS.costCenter) {
    return costCenterCandidates(source, model);
  }

  if (source.id === SOURCE_IDS.constants) {
    return [compileTimeConstantCandidate({
      source,
      range: model.ranges.constants,
      constants: {
        theCityFlag: 1,
        theFlagNo: 0,
        theConstFiaSaveFlag: 2222
      },
      consumers: [
        `${SOURCE_IDS.lifecycle}.event.1`,
        `${SOURCE_IDS.lifecycle}.event.3`,
        `${SOURCE_IDS.lifecycle}.event.4`
      ],
      sourceDescription: "travel-scope and save-marker globals",
      targetDescription: "field-backed deterministic lifecycle actions"
    })];
  }

  if (source.id === SOURCE_IDS.lifecycle) {
    return lifecycleCandidates(source, model);
  }

  if (source.id === SOURCE_IDS.finance) {
    return [compileTimeConstantCandidate({
      source,
      range: model.ranges.financeFlag,
      constants: { theFinanceFlag: 1 },
      consumers: [
        `${SOURCE_IDS.lifecycle}.event.3`,
        `${SOURCE_IDS.lifecycle}.event.4`
      ],
      sourceDescription: "top-level theFinanceFlag=1 plus finance helper definitions",
      targetDescription: "compile-time dead-branch proof and deterministic finance-detail action"
    })];
  }

  return [];
}

function costCenterCandidates(source, model) {
  const mapping = lifecycleMapping(
    "legacy first-cost-center option mutation",
    "MKXFORM.setProps + unconditional second-cost-center reset"
  );
  return [
    compiledCandidate({
      index: model.bindings.firstCostCenter.start,
      event: "onChange",
      scope: "control",
      controlId: FIELD_IDS.firstCostCenter,
      function: buildCostCenterOnChange(model),
      sourceRefs: [model.sources.costCenter.sourceRef],
      ranges: [
        model.ranges.changeCostCenter,
        model.ranges.firstCostCenterBinding
      ],
      mapping
    }),
    compiledCandidate({
      index: model.bindings.secondCostCenter.start,
      event: "onChange",
      scope: "control",
      controlId: FIELD_IDS.secondCostCenter,
      sourceActionKey: inlineOnChangeSourceActionKey(
        source.sourceRef,
        model.bindings.secondCostCenter.start
      ),
      function: [
        "function onChange(value, rowNum, parentRowNum) {",
        "  // The target finance compiler reads fd_bseg_kostl directly; no legacy object mirror is needed.",
        "}"
      ].join("\n"),
      sourceRefs: [
        model.sources.costCenter.sourceRef,
        model.sources.finance.sourceRef
      ],
      ranges: [
        model.ranges.secondCostCenterBinding,
        model.ranges.financeFlag
      ],
      mapping: lifecycleMapping(
        "theFinanceObj.fd_bseg_kostl cache mirror",
        "deterministic finance action reads current MKXFORM field value"
      )
    })
  ];
}

function lifecycleCandidates(source, model) {
  const sharedRefs = [
    model.sources.lifecycle.sourceRef,
    model.sources.costCenter.sourceRef,
    model.sources.finance.sourceRef
  ];
  return [
    compiledCandidate({
      index: model.bindings.city.start,
      event: "onChange",
      scope: "control",
      controlId: FIELD_IDS.cityMode,
      sourceActionKey: model.citySourceActionKey,
      function: buildCityModeOnChange(),
      sourceRefs: [
        model.sources.lifecycle.sourceRef,
        model.sources.trafficCalculation.sourceRef
      ],
      ranges: [
        model.ranges.city,
        model.ranges.clearTraffic,
        model.ranges.trafficCalculation
      ],
      nativeRules: [model.cityNativeRuleId],
      mapping: lifecycleMapping(
        "city-mode helper flag, clearTrainData, row helper, and trafficCityChange",
        "MKXFORM helper flag + detail reset; native row rule and deterministic calculations"
      )
    }),
    compiledCandidate({
      index: model.bindings.department.start,
      event: "onChange",
      scope: "control",
      controlId: FIELD_IDS.department,
      sourceActionKey: inlineOnChangeSourceActionKey(
        source.sourceRef,
        model.bindings.department.start
      ),
      function: buildDepartmentOnChange(model),
      sourceRefs: [
        model.sources.lifecycle.sourceRef,
        model.sources.costCenter.sourceRef
      ],
      ranges: [
        model.ranges.department,
        model.ranges.setDepartment,
        model.ranges.changeCostCenter
      ],
      mapping: lifecycleMapping(
        "setDepartMentSelect + changeBsegValue",
        "MKXFORM first-cost-center value and second-cost-center options"
      )
    }),
    compiledCandidate({
      index: model.bindings.load.start,
      event: "onLoad",
      scope: "global",
      function: buildLifecycleOnLoad(model),
      sourceRefs: sharedRefs,
      ranges: [
        model.ranges.load,
        model.ranges.setDepartment,
        model.ranges.changeCostCenter,
        model.ranges.financeFlag
      ],
      mapping: lifecycleMapping(
        "window-load travel initialization with theFinanceFlag branch",
        "field-backed row/cost-center initialization; proven finance branch folded"
      ),
      semanticHints: {
        compileTimeConstants: { theFinanceFlag: 1 },
        deadSourceEffects: [
          "fd_voucher_no reset",
          "fd_voucher_msg reset",
          "fd_link_address reset",
          "fd_finance_detail blank-row append"
        ]
      }
    }),
    compiledCandidate({
      index: model.bindings.submit.start,
      event: "onBeforeSubmit",
      scope: "global",
      function: buildSubmit(model),
      sourceRefs: [
        model.sources.lifecycle.sourceRef,
        model.sources.wbs.sourceRef,
        model.sources.finance.sourceRef,
        model.sources.payeeCalculation.sourceRef,
        model.sources.roundingHelper.sourceRef
      ],
      ranges: [
        model.ranges.submit,
        model.ranges.wbs,
        model.ranges.financeFlag,
        model.ranges.payeeCalculation,
        model.ranges.payeeAggregate,
        model.ranges.roundingHelper
      ],
      mapping: {
        source: "WBS/card/payee-difference/save-marker submit queue",
        target: "deterministic onBeforeSubmit validation and MKXFORM save marker",
        basis: TRAVEL_REIMBURSEMENT_SUBMIT_BASIS,
        reviewRequired: false
      },
      semanticHints: {
        compileTimeConstants: {
          theFinanceFlag: 1,
          theConstFiaSaveFlag: 2222
        },
        nativeCalculations: ["fd_payee_total", "fd_payee_diff"]
      }
    })
  ];
}

function compileTimeConstantCandidate({
  source,
  range,
  constants,
  consumers,
  sourceDescription,
  targetDescription
}) {
  return compiledCandidate({
    index: 0,
    event: "onLoad",
    scope: "global",
    function: [
      "function onLoad() {",
      "  // Source globals were consumed by deterministic target actions at compile time.",
      "}"
    ].join("\n"),
    sourceRefs: [source.sourceRef],
    ranges: [range],
    mapping: lifecycleMapping(sourceDescription, targetDescription),
    semanticHints: {
      compileTimeConstants: constants,
      compileTimeConsumers: consumers
    }
  });
}

function compiledCandidate({
  index,
  event,
  scope,
  controlId,
  sourceActionKey,
  function: functionText,
  sourceRefs,
  ranges,
  nativeRules = [],
  mapping,
  semanticHints = {}
}) {
  return {
    index,
    event,
    scope,
    controlId,
    sourceActionKey,
    function: functionText,
    sourceRefs: uniqueStrings(sourceRefs),
    translationStatus: "mapped",
    coverage: {
      status: "translated",
      nativeRules,
      residuals: []
    },
    functionMappings: [mapping],
    semanticHints: {
      ...semanticHints,
      coveredCalculationRanges: dedupeRanges(ranges)
    }
  };
}

function lifecycleMapping(source, target) {
  return {
    source,
    target,
    basis: TRAVEL_REIMBURSEMENT_LIFECYCLE_BASIS,
    reviewRequired: false
  };
}

function dedupeRanges(ranges) {
  const seen = new Set();
  return (ranges || []).filter((range) => {
    const key = `${range?.sourceRef}\u0000${range?.start}\u0000${range?.end}\u0000${range?.name}`;
    if (!range || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter((value) =>
    typeof value === "string" && value.trim()
  ))];
}
