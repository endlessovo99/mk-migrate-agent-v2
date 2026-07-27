import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inspectDeterministicScriptBranchProof
} from "../../src/dsl/deterministic-script-translations.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { projectTemplate, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture =
  "tests/fixtures/route-validation/detail-cascade-actions/route-detail-cascade-actions_SysFormTemplate.xml";
const fullSourceFixture =
  "tests/fixtures/source/1927955f6e544383f46970f48468a743";
const targetTableId = "fd_route_target_lines";
const deterministicBasis = "deterministic-detail-cascade-actions";
const targetControlIds = [
  "fd_route_primary_1",
  "fd_route_primary_2",
  "fd_route_primary_3",
  "fd_route_kind",
  "fd_route_secondary_1",
  "fd_route_secondary_2",
  "fd_route_secondary_3"
];
const primaryOptions = [
  { label: "Primary A", value: "ROUTE_PRIMARY_A" },
  { label: "Primary B", value: "ROUTE_PRIMARY_B" }
];
const secondaryOptions = [
  { label: "Secondary A", value: "ROUTE_SECONDARY_A" },
  { label: "Secondary B", value: "ROUTE_SECONDARY_B" }
];
const cascadeGroups = [1, 2, 3].map((index) => ({
  primaryId: `fd_route_primary_${index}`,
  secondaryId: `fd_route_secondary_${index}`,
  primaryStoreId: `fd_route_p${index}_store`,
  secondaryStoreId: `fd_route_s${index}_store`
}));
const rowOptionExpectations = cascadeGroups.flatMap(({ primaryId, secondaryId }) => [
  {
    controlId: primaryId,
    dependencyFieldId: "fd_route_kind",
    options: primaryOptions,
    rowOptions: {
      dependencyFieldId: "fd_route_kind",
      cases: [{
        value: "ROUTE_KIND_MULTI",
        options: [{ label: "Primary A", value: "ROUTE_PRIMARY_A" }]
      }],
      defaultOptions: [{ label: "Primary B", value: "ROUTE_PRIMARY_B" }]
    }
  },
  {
    controlId: secondaryId,
    dependencyFieldId: primaryId,
    options: secondaryOptions,
    rowOptions: {
      dependencyFieldId: primaryId,
      cases: [{
        value: "ROUTE_PRIMARY_A",
        options: [{ label: "Secondary A", value: "ROUTE_SECONDARY_A" }]
      }],
      defaultOptions: [{ label: "Secondary B", value: "ROUTE_SECONDARY_B" }]
    }
  }
]);

describe("detail cascade action Route case", () => {
  it("drafts one row-restore load action and seven table-bound named change actions", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(sourceDraft);
    const sourceRefPrefix = "source.form.jsp.jsp_route_detail_cascade.";
    const fragmentSources = sourceDraft.scripts.sources.filter((source) =>
      source.fragmentId === "jsp_route_detail_cascade"
    );
    const actions = dsl.scripts.actions.filter((action) =>
      action.sourceRefs.some((sourceRef) => sourceRef.startsWith(sourceRefPrefix))
    );
    const sourceTable = dsl.form.fields.find((field) => field.id === "fd_route_source_lines");
    const targetTable = dsl.form.fields.find((field) => field.id === targetTableId);

    assert.equal(sourceTable?.columns.length, 2);
    assert.equal(targetTable?.columns.length, 17);
    assert.equal(fragmentSources.length, 2);
    assert.equal(
      fragmentSources.reduce((count, source) =>
        count + (source.javascript.match(/Com_AddEventListener/g) || []).length, 0
      ),
      1
    );
    assert.equal(
      fragmentSources.reduce((count, source) =>
        count + (source.javascript.match(/AttachXFormValueChangeEventById/g) || []).length, 0
      ),
      7
    );
    assert.equal(
      fragmentSources.some((source) =>
        source.javascript.includes("fd_route_secondary_missing")
      ),
      true
    );
    assert.equal(
      targetTable.columns.some((column) =>
        column.id === "fd_route_secondary_missing"
      ),
      false
    );
    assert.equal(actions.length, 8, JSON.stringify({
      actions: actions.map(actionSummary),
      warnings: dsl.scripts.warnings
    }));

    const load = actions.find((action) => action.event === "onLoad");
    const changes = actions.filter((action) => action.event === "onChange");

    assert.ok(load);
    assert.equal(load.scope, "global");
    assert.equal(load.controlId, undefined);
    assert.equal(load.tableId, undefined);
    assert.equal(load.translationStatus, "mapped");
    assert.deepEqual(
      changes.map((action) => action.controlId),
      targetControlIds
    );
    assert.equal(changes.every((action) => action.scope === "control"), true);
    assert.equal(changes.every((action) => action.tableId === targetTableId), true);
    assert.equal(changes.every((action) => action.translationStatus === "mapped"), true);

    for (const action of actions) {
      assert.deepEqual(action.coverage, {
        status: "translated",
        nativeRules: [],
        residuals: []
      });
      assert.equal(action.functionMappings?.length, 1);
      assert.equal(action.functionMappings[0].basis, deterministicBasis);
      assert.equal(action.functionMappings[0].reviewRequired, false);
      assert.equal(action.deterministicBranchProof?.basis, deterministicBasis);
      assert.equal(
        Array.isArray(action.semanticHints?.coveredCalculationRanges) &&
          action.semanticHints.coveredCalculationRanges.length > 0,
        true,
        action.id
      );
      assert.equal(
        inspectDeterministicScriptBranchProof(action, {
          calculationDecisions: dsl.scripts.calculationDecisions
        }).ok,
        true,
        action.id
      );
      assert.doesNotMatch(action.function, /MKXFORM\.setProps/);
    }

    assertRowOptionDsl(targetTable);
    assertLoadBehavior(load);
    assertLoadPreservesInactiveSecondary(load);
    assertChangeBehavior(changes);
    assert.equal(
      dsl.scripts.warnings.some((warning) =>
        warning.code === "script.detail_control_table_required"
      ),
      false,
      JSON.stringify(dsl.scripts.warnings)
    );
  });

  it("keeps persisted secondary values on inactive rows in the full source", () => {
    const sourceDraft = cleanSourceFile(fullSourceFixture);
    const dsl = draftSourceDraft(sourceDraft);
    const cascadeActions = dsl.scripts.actions.filter((action) =>
      action.functionMappings?.some((mapping) =>
        mapping.basis === deterministicBasis
      )
    );
    const loadActions = cascadeActions.filter((action) =>
      action.event === "onLoad"
    );
    const kind = cascadeActions.find((action) =>
      action.controlId === "fd_part_type"
    );

    assert.equal(loadActions.length, 1);
    assertLoadPreservesInactiveSecondary(loadActions[0], {
      activeRequired: false
    });
    assert.ok(kind);
    assert.deepEqual(kind.semanticHints.detailCascade.kindVisibilitySecondaryIds, [
      "fd_pos22",
      "fd_pos32"
    ]);
    assert.deepEqual(kind.semanticHints.detailCascade.kindRequiredSecondaryIds, []);
    assert.deepEqual(kind.semanticHints.detailCascade.kindNonrequiredSecondaryIds, [
      "fd_pos22",
      "fd_pos32"
    ]);
    assert.deepEqual(kind.semanticHints.detailCascade.missingKindTargetIds, [
      "fd_pos2"
    ]);
    assertOptionalVisibilityState(kind.function, "fd_3d69cf2b1acb52", "fd_pos22");
    assertOptionalVisibilityState(kind.function, "fd_3d69cf2b1acb52", "fd_pos32");
    assert.equal(
      kind.function.includes(
        `${tablePlaceholder("fd_3d69cf2b1acb52")}.fd_pos12`
      ),
      false,
      "the source fd_pos2 typo must not be repaired into fd_pos12"
    );
  });

  it("reviews, trusts, persists, and reads back all eight actions through fake NewOA", async () => {
    const result = await runRouteCase("detail-cascade-actions-success");
    const expectedActions = result.dsl.scripts.actions.filter((action) =>
      action.sourceRefs.some((sourceRef) =>
        sourceRef.startsWith("source.form.jsp.jsp_route_detail_cascade.")
      )
    );
    const observedActions = result.execution.readback.form.scripts.actions;
    const changes = expectedActions.filter((action) => action.event === "onChange");

    assert.equal(result.dsl.trust.executable, true);
    assert.equal(expectedActions.length, 8);
    assert.equal(observedActions.length, 8);
    assert.equal(
      expectedActions.every((action) => action.translationStatus === "mapped"),
      true
    );
    assert.equal(
      expectedActions.every((action) =>
        inspectDeterministicScriptBranchProof(action, {
          calculationDecisions: result.dsl.scripts.calculationDecisions
        }).ok
      ),
      true
    );
    assert.equal(
      JSON.stringify(result).includes("script.detail_control_table_required"),
      false
    );
    assert.equal(
      expectedActions.some((action) => action.function.includes("MKXFORM.setProps")),
      false
    );

    assertNativeRowOptions(result.dsl);

    const observedLoad = observedActions.find((action) => action.event === "onLoad");
    assert.ok(observedLoad);
    assert.equal(observedLoad.controlKey, undefined);

    const physicalTables = new Set();
    for (const expected of changes) {
      assert.equal(expected.tableId, targetTableId);
      assert.ok(targetControlIds.includes(expected.controlId));
      const observed = observedActions.find((action) =>
        action.event === "onChange" &&
        action.controlKey?.endsWith(`.${expected.controlId}`)
      );
      assert.ok(observed, `${expected.controlId} must survive native readback`);
      assert.equal(observed.hasCanonicalGuard, true);
      const physicalTable = observed.controlKey.slice(
        0,
        observed.controlKey.lastIndexOf(".")
      );
      assert.notEqual(physicalTable, targetTableId);
      assert.notEqual(physicalTable, "route_model_generated");
      physicalTables.add(physicalTable);
    }
    assert.equal(physicalTables.size, 1);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.readback.partitions.scripts, "verified");
  });
});

function assertRowOptionDsl(targetTable) {
  for (const expected of rowOptionExpectations) {
    const column = targetTable.columns.find((candidate) =>
      candidate.id === expected.controlId
    );
    assert.ok(column, expected.controlId);
    assert.deepEqual(column.props.options, expected.options);
    assert.deepEqual(column.props.rowOptions, expected.rowOptions);
    assert.equal(column.props.optionSource, undefined);
    assert.equal(column.props.js, undefined);
  }
}

function assertLoadBehavior(action) {
  const table = tablePlaceholder();
  assert.match(action.function, /function\s+onLoad\s*\(/);
  assert.equal(action.function.includes(`MKXFORM.getValue("${table}")`), true);
  assert.equal(action.function.includes("rowNum"), true);
  assert.equal(action.function.includes("fd_route_kind_store"), true);
  for (const group of cascadeGroups) {
    for (const controlId of [group.primaryId, group.secondaryId]) {
      assert.equal(action.function.includes(`${table}.${controlId}`), true, controlId);
    }
    for (const storeId of [group.primaryStoreId, group.secondaryStoreId]) {
      assert.equal(
        action.function.includes(`row[${JSON.stringify(storeId)}]`),
        true,
        storeId
      );
    }
    assertDetailRowState(action.function, group.secondaryId);
  }
}

function assertLoadPreservesInactiveSecondary(
  action,
  { activeRequired = true } = {}
) {
  const cascade = action.semanticHints.detailCascade;
  const physicalTable = "detail_cascade_test_table";
  const activeRow = {
    [cascade.kindStoreId]: cascade.activeValue
  };
  const inactiveRow = {
    [cascade.kindStoreId]: "INACTIVE_KIND"
  };
  for (const [index, group] of cascade.groups.entries()) {
    activeRow[group.primaryStoreId] = `active-primary-${index}`;
    activeRow[group.secondaryStoreId] = `active-secondary-${index}`;
    inactiveRow[group.primaryStoreId] = `inactive-primary-${index}`;
    inactiveRow[group.secondaryStoreId] = `persisted-secondary-${index}`;
  }

  const updates = [];
  const attributes = [];
  const executable = action.function.replaceAll(
    tablePlaceholder(cascade.tableId),
    physicalTable
  );
  const onLoad = Function("MKXFORM", `${executable}; return onLoad;`)({
    getValue(controlId) {
      assert.equal(controlId, physicalTable);
      return [activeRow, inactiveRow];
    },
    updateControl(controlId, rowNum, value) {
      updates.push({ controlId, rowNum, value });
    },
    setDetailFieldItemAttr(tableId, attribute, rowNum, controlId) {
      attributes.push({ tableId, attribute, rowNum, controlId });
    }
  });
  onLoad();

  for (const [index, group] of cascade.groups.entries()) {
    const secondaryControl = `${physicalTable}.${group.secondaryId}`;
    assert.deepEqual(
      updates.filter((update) => update.controlId === secondaryControl),
      [{
        controlId: secondaryControl,
        rowNum: 0,
        value: `active-secondary-${index}`
      }],
      `${group.secondaryId} must not be overwritten for inactive rows`
    );
    assert.deepEqual(
      attributes.filter((item) =>
        item.rowNum === 1 && item.controlId === secondaryControl
      ),
      [
        {
          tableId: physicalTable,
          attribute: 4,
          rowNum: 1,
          controlId: secondaryControl
        },
        {
          tableId: physicalTable,
          attribute: 6,
          rowNum: 1,
          controlId: secondaryControl
        }
      ],
      `${group.secondaryId} must only be hidden and made optional for inactive rows`
    );
    assert.deepEqual(
      attributes.filter((item) =>
        item.rowNum === 0 && item.controlId === secondaryControl
      ),
      [
        {
          tableId: physicalTable,
          attribute: 5,
          rowNum: 0,
          controlId: secondaryControl
        },
        ...(activeRequired
          ? [{
              tableId: physicalTable,
              attribute: 3,
              rowNum: 0,
              controlId: secondaryControl
            }]
          : [])
      ],
      `${group.secondaryId} must preserve the source active-row required state`
    );
  }
}

function assertOptionalVisibilityState(functionText, tableId, controlId) {
  const table = tablePlaceholder(tableId);
  assert.equal(
    functionText.includes(
      `MKXFORM.setDetailFieldItemAttr("${table}", active ? 5 : 4, rowNum, "${table}.${controlId}")`
    ),
    true,
    controlId
  );
  assert.equal(
    functionText.includes(
      `MKXFORM.setDetailFieldItemAttr("${table}", active ? 3 : 6, rowNum, "${table}.${controlId}")`
    ),
    false,
    `${controlId} must not become required when the source only shows it`
  );
  assert.match(
    functionText,
    new RegExp(
      `if \\(!active\\) \\{\\s*MKXFORM\\.setDetailFieldItemAttr\\(${escapeRegExp(
        JSON.stringify(table)
      )}, 6, rowNum, ${escapeRegExp(JSON.stringify(`${table}.${controlId}`))}\\)`
    )
  );
}

function assertChangeBehavior(actions) {
  const byControl = new Map(actions.map((action) => [action.controlId, action]));
  const kind = byControl.get("fd_route_kind");
  assert.ok(kind);
  assert.equal(kind.function.includes(`${tablePlaceholder()}.fd_route_kind_store`), true);
  for (const group of cascadeGroups) {
    for (const controlId of [
      group.primaryId,
      group.secondaryId,
      group.primaryStoreId,
      group.secondaryStoreId
    ]) {
      assert.equal(kind.function.includes(`${tablePlaceholder()}.${controlId}`), true, controlId);
    }
  }
  assertDetailRowStateMissing(kind.function, cascadeGroups[0].secondaryId);
  for (const group of cascadeGroups.slice(1)) {
    assertDetailRowState(kind.function, group.secondaryId);
  }
  assert.deepEqual(
    kind.semanticHints.detailCascade.missingKindTargetIds,
    ["fd_route_secondary_missing"]
  );

  for (const group of cascadeGroups) {
    const primary = byControl.get(group.primaryId);
    const secondary = byControl.get(group.secondaryId);
    assert.ok(primary);
    assert.ok(secondary);
    assert.match(primary.function, /function\s+onChange\s*\(\s*value\s*,\s*rowNum\b/);
    assert.equal(primary.function.includes(`${tablePlaceholder()}.${group.primaryStoreId}`), true);
    assert.equal(primary.function.includes(`${tablePlaceholder()}.${group.secondaryId}`), true);
    assert.equal(primary.function.includes(`${tablePlaceholder()}.${group.secondaryStoreId}`), true);
    assert.equal(primary.function.includes('rowNum, ""'), true);
    assert.match(secondary.function, /function\s+onChange\s*\(\s*value\s*,\s*rowNum\b/);
    assert.equal(secondary.function.includes(`${tablePlaceholder()}.${group.secondaryStoreId}`), true);
  }
}

function assertDetailRowState(functionText, controlId) {
  const table = tablePlaceholder();
  assert.equal(
    functionText.includes(
      `MKXFORM.setDetailFieldItemAttr("${table}", active ? 5 : 4, rowNum, "${table}.${controlId}")`
    ),
    true,
    controlId
  );
  assert.equal(
    functionText.includes(
      `MKXFORM.setDetailFieldItemAttr("${table}", active ? 3 : 6, rowNum, "${table}.${controlId}")`
    ),
    true,
    controlId
  );
}

function assertDetailRowStateMissing(functionText, controlId) {
  const table = tablePlaceholder();
  for (const attributes of ["active ? 5 : 4", "active ? 3 : 6"]) {
    assert.equal(
      functionText.includes(
        `MKXFORM.setDetailFieldItemAttr("${table}", ${attributes}, rowNum, "${table}.${controlId}")`
      ),
      false,
      controlId
    );
  }
}

function assertNativeRowOptions(dsl) {
  const config = xformConfig(projectTemplate(dsl));
  const detail = config.dataModel.find((model) =>
    model.fdType === "detail" &&
    model.dynamicProps?.detailFieldName === targetTableId
  );
  assert.ok(detail);
  for (const expected of rowOptionExpectations) {
    const field = detail.fdFields.find((candidate) =>
      candidate.fdName === expected.controlId
    );
    assert.ok(field, expected.controlId);
    const controlProps = JSON.parse(field.fdAttribute).config.controlProps;
    const dependency = `${detail.fdTableName}.${expected.dependencyFieldId}`;

    assert.equal(controlProps.optionSource, "JavaScript");
    assert.equal(typeof controlProps.js, "string");
    assert.match(controlProps.js, /\boptions\b/);
    assert.match(controlProps.js, /\bdeps\b/);
    assert.match(
      controlProps.js,
      /function\s*\(\s*controlProps\s*,\s*rowNum\s*,\s*MKXFORM\s*\)/
    );
    assert.match(controlProps.js, /\bMKXFORM\b/);
    assert.equal(controlProps.js.includes(dependency), true, controlProps.js);
    assert.match(
      controlProps.js,
      /MKXFORM\.getValue\([^)]*\{\s*detailRowIndex\s*:\s*rowNum\s*\}\s*\)/
    );
    assert.equal(
      expected.options.every((option) =>
        controlProps.js.includes(option.value)
      ),
      true,
      controlProps.js
    );
    assert.doesNotMatch(controlProps.js, /MKXFORM\.setProps/);
    assert.deepEqual(controlProps.options, expected.options);
  }
}

function tablePlaceholder(tableId = targetTableId) {
  return `\${table:${tableId}}`;
}

function actionSummary(action) {
  return {
    id: action.id,
    event: action.event,
    scope: action.scope,
    controlId: action.controlId,
    tableId: action.tableId,
    translationStatus: action.translationStatus,
    branchProvenance: action.branchProvenance?.status
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
