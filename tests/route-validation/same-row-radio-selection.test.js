import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inspectDeterministicScriptBranchProof
} from "../../src/dsl/deterministic-script-translations.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture =
  "tests/fixtures/route-validation/same-row-radio-selection/route-same-row-radio-selection_SysFormTemplate.xml";
const realFixture = "tests/fixtures/source/18e2b225a8abe4503405e6e4bb88aba0";
const basis = "deterministic-same-row-radio-selection";

describe("same-row radio selection Route case", () => {
  it("maps source option indices to target radio values without DOM runtime calls", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const action = actionsByBasis(dsl, basis).find((candidate) =>
      candidate.controlId === "fd_route_tool"
    );

    assert.ok(action);
    assert.equal(action.tableId, "fd_route_trip_lines");
    assert.equal(action.translationStatus, "mapped");
    assert.equal(
      dsl.scripts.actions.some((candidate) =>
        candidate.controlId === "fd_route_tool" &&
        candidate.translationStatus === "needs_review"
      ),
      false
    );
    assert.deepEqual(action.coverage, {
      status: "translated",
      nativeRules: [],
      residuals: []
    });
    assert.equal(
      inspectDeterministicScriptBranchProof(action, {
        calculationDecisions: dsl.scripts.calculationDecisions
      }).ok,
      true
    );
    assert.doesNotMatch(
      action.function,
      /GetXFormSameRowFieldById|\.checked|document|window|\$\s*\(/
    );

    const writes = executeSelection(action, [
      { value: "route_air", rowNum: 3 },
      { value: ["route_rail"], rowNum: 4 },
      { value: "route_road", rowNum: 5 },
      { value: "route_ferry", rowNum: 6 }
    ]);
    assert.deepEqual(writes, [
      {
        controlId: "route_trip_lines_physical.fd_route_class",
        rowNum: 3,
        value: "route_basic"
      },
      {
        controlId: "route_trip_lines_physical.fd_route_class",
        rowNum: 4,
        value: "route_second"
      },
      {
        controlId: "route_trip_lines_physical.fd_route_class",
        rowNum: 5,
        value: ""
      }
    ]);
    assert.equal(writes.every((write) => typeof write.value === "string"), true);
    assert.equal(
      checkDraft(dsl).diagnostics.some((diagnostic) => diagnostic.level === "error"),
      false
    );
  });

  it("keeps an uncovered sibling statement explicit instead of claiming full coverage", () => {
    const source = structuredClone(cleanSourceFile(fixture));
    const target = source.scripts.sources.find((candidate) =>
      candidate.sourceRef === "source.form.jsp.jsp_route_same_row_radio.script.1"
    );
    target.javascript = target.javascript.replace(
      "chooseRouteClass(value, domElement);",
      [
        "chooseRouteClass(value, domElement);",
        "       preserveUnknownLegacySideEffect(value);"
      ].join("\n")
    );
    const dsl = draftSourceDraft(source);
    const sourceRef = "source.form.jsp.jsp_route_same_row_radio.script.1";
    const selection = actionsByBasis(dsl, basis).find((candidate) =>
      candidate.controlId === "fd_route_tool"
    );
    const residual = dsl.scripts.actions.find((candidate) =>
      candidate.controlId === "fd_route_tool" &&
      candidate.translationStatus === "needs_review" &&
      candidate.coverage?.residuals?.some((item) =>
        item.code === "script.residual.untranslated_callback_statement"
      )
    );

    assert.ok(selection);
    assert.ok(residual);
    assert.equal(selection.sourceActionKey, residual.sourceActionKey);
    assert.equal(selection.sourceRefs.includes(sourceRef), true);
    assert.match(
      residual.coverage.residuals[0].evidence,
      /preserveUnknownLegacySideEffect/
    );
  });

  it("does not guess dynamic or out-of-range option indices", () => {
    for (const replacement of [
      "classField[selectedIndex].checked = true;",
      "classField[99].checked = true;"
    ]) {
      const source = structuredClone(cleanSourceFile(fixture));
      const target = source.scripts.sources.find((candidate) =>
        candidate.sourceRef === "source.form.jsp.jsp_route_same_row_radio.script.1"
      );
      target.javascript = target.javascript.replace(
        "classField[2].checked = true;",
        replacement
      );
      const dsl = draftSourceDraft(source);
      assert.equal(actionsByBasis(dsl, basis).length, 0, replacement);
    }
  });

  it("preserves grouped travel totals and the default class as separate actions", () => {
    const dsl = draftSourceDraft(cleanSourceFile(realFixture));
    const sourceRef = "source.form.jsp.fd_3bb1cfa690b988.script.1";
    const relevant = dsl.scripts.actions.filter((action) =>
      action.controlId === "fd_traffic_tool" &&
      action.sourceRefs.includes(sourceRef)
    );
    const grouped = relevant.find((action) =>
      action.functionMappings?.some((mapping) =>
        mapping.basis === "deterministic-grouped-detail-calculation"
      )
    );
    const selection = relevant.find((action) =>
      action.functionMappings?.some((mapping) => mapping.basis === basis)
    );

    assert.ok(grouped);
    assert.ok(selection);
    assert.notEqual(grouped.id, selection.id);
    assert.equal(grouped.sourceActionKey, selection.sourceActionKey);
    assert.equal(grouped.translationStatus, "mapped");
    assert.equal(selection.translationStatus, "mapped");
    assert.match(grouped.function, /MKXFORM\.setValue\("fd_train"/);
    assert.equal(
      inspectDeterministicScriptBranchProof(grouped, {
        calculationDecisions: dsl.scripts.calculationDecisions
      }).ok,
      true
    );
    assert.equal(
      inspectDeterministicScriptBranchProof(selection, {
        calculationDecisions: dsl.scripts.calculationDecisions
      }).ok,
      true
    );

    assert.deepEqual(executeSelection(selection, [
      { value: "airplane", rowNum: 0 },
      { value: ["train"], rowNum: 1 },
      { value: "car", rowNum: 2 },
      { value: "ship", rowNum: 3 }
    ]), [
      {
        controlId: "route_trip_lines_physical.fd_traffic_space",
        rowNum: 0,
        value: "经济舱"
      },
      {
        controlId: "route_trip_lines_physical.fd_traffic_space",
        rowNum: 1,
        value: "二等座"
      },
      {
        controlId: "route_trip_lines_physical.fd_traffic_space",
        rowNum: 2,
        value: ""
      }
    ]);
  });
});

function actionsByBasis(dsl, expectedBasis) {
  return (dsl.scripts?.actions || []).filter((action) =>
    action.functionMappings?.some((mapping) => mapping.basis === expectedBasis)
  );
}

function executeSelection(action, events) {
  const writes = [];
  const executable = action.function.replaceAll(
    `\${table:${action.tableId}}`,
    "route_trip_lines_physical"
  );
  const onChange = Function("MKXFORM", `${executable}; return onChange;`)({
    updateControl(controlId, rowNum, value) {
      writes.push({ controlId, rowNum, value });
    }
  });
  for (const event of events) onChange(event.value, event.rowNum);
  return writes;
}
