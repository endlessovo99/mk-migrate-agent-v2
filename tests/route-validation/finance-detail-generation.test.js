import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { financeDetailGenerationTranslation } from "../../src/translator/finance-detail-generation.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/finance-detail-generation/route-finance-detail-generation_SysFormTemplate.xml";

describe("finance detail generation Route case", () => {
  it("maps a cross-fragment legacy replacement button to a data-only synchronous MK action", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const button = dsl.form.fields.find(field => field.componentId === "xform-button");
    const action = dsl.scripts.actions.find(candidate =>
      candidate.event === "onClick" && candidate.controlId === button?.id
    );

    assert.equal(button?.id, "jsp_fixture_button");
    assert.equal(action?.translationStatus, "mapped");
    assert.equal(action?.functionMappings?.[0]?.basis, "deterministic-finance-detail-generation");
    assert.equal(action?.sourceRefs.length >= 4, true);
    assert.match(action.function, /var fixtureFinanceTable = "\$\{table:fd_fixture_finance\}"/);
    assert.match(action.function, /MKXFORM\.setDetailValues\(fixtureFinanceTable, data\)/);
    assert.doesNotMatch(action.function, /\b(?:document|DocList_TableInfo|DocList_AddRow|buildDetailTableFieldId|SetXFormFieldValueById)\b|jQuery|\$\(/);
    assert.ok(dsl.scripts.calculationDecisions.some(decision =>
      decision.classification === "manual" &&
      decision.sourceRefs.includes("source.form.jsp.jsp_fixture_handler.script.1") &&
      decision.targetRefs.includes("fd_fixture_status")
    ), "an unrelated calculation in the translated handler fragment must remain explicit");

    const calls = { values: { fd_fixture_status: "old" }, rows: [] };
    const executable = action.function
      .replaceAll("${table:fd_fixture_projects}", "physical_projects")
      .replaceAll("${table:fd_fixture_payees}", "physical_payees")
      .replaceAll("${table:fd_fixture_finance}", "physical_finance");
    const onClick = Function("MKXFORM", `${executable}; return onClick;`)({
      getValue(id) {
        if (id === "physical_projects") return { values: [{ fd_fixture_wbs: "W1" }, { fd_fixture_wbs: "W2" }] };
        if (id === "physical_payees") return { values: [{
          fd_fixture_payee_amount: 100,
          fd_fixture_payee_name: "张三",
          fd_fixture_card: "62220001"
        }] };
        return {
          fd_fixture_amount: 100,
          fd_fixture_currency: "CNY",
          fd_fixture_bank: "private",
          ...calls.values
        }[id];
      },
      getValueText() { return ""; },
      setValue(id, value) { calls.values[id] = value; },
      setDetailValues(id, rows) { calls.rows.push({ id, rows }); }
    });

    onClick();

    assert.equal(calls.values.fd_fixture_status, "");
    assert.equal(calls.rows.length, 1);
    assert.equal(calls.rows[0].id, "physical_finance");
    assert.deepEqual(calls.rows[0].rows, [
      {
        fd_fixture_line_no: 1,
        fd_fixture_posting_key: "40",
        fd_fixture_line_amount: "50.00",
        fd_fixture_line_currency: "CNY",
        fd_fixture_line_wbs: "W1",
        fd_fixture_line_payee: "",
        fd_fixture_line_card: ""
      },
      {
        fd_fixture_line_no: 2,
        fd_fixture_posting_key: "40",
        fd_fixture_line_amount: 50,
        fd_fixture_line_currency: "CNY",
        fd_fixture_line_wbs: "W2",
        fd_fixture_line_payee: "",
        fd_fixture_line_card: ""
      },
      {
        fd_fixture_line_no: 3,
        fd_fixture_posting_key: "50",
        fd_fixture_line_amount: "-100.00",
        fd_fixture_line_currency: "CNY",
        fd_fixture_line_wbs: "",
        fd_fixture_line_payee: "张三",
        fd_fixture_line_card: "62220001"
      }
    ]);
  });

  it("fails closed when a cross-fragment function or global dependency is ambiguous", () => {
    const source = cleanSourceFile(fixture);
    const sources = source.scripts.sources;
    assert.ok(financeDetailGenerationTranslation({ handler: "compileFixtureVoucher", sources }));
    assert.equal(financeDetailGenerationTranslation({
      handler: "compileFixtureVoucher",
      sources: [...sources, {
        sourceRef: "source.ambiguous.function",
        javascript: "function fixtureRound(value) { return Number(value); }"
      }]
    }), undefined);
    assert.equal(financeDetailGenerationTranslation({
      handler: "compileFixtureVoucher",
      sources: [...sources, {
        sourceRef: "source.ambiguous.global",
        javascript: "var fixtureFinanceTable = 'fd_other_finance';"
      }]
    }), undefined);
  });

  it("fails closed when payee conditions or row construction contain unmodeled semantics", () => {
    const sources = cleanSourceFile(fixture).scripts.sources;
    const mutate = replacement => sources.map(source => ({
      ...source,
      javascript: replacement(String(source.javascript || ""))
    }));

    assert.equal(financeDetailGenerationTranslation({
      handler: "compileFixtureVoucher",
      sources: mutate(source => source.replace(
        "if (Number(currentAmount) > 0)",
        "if (Number(currentAmount) < 0)"
      ))
    }), undefined, "a reversed payee amount condition must not be rewritten as amount > 0");

    assert.equal(financeDetailGenerationTranslation({
      handler: "compileFixtureVoucher",
      sources: mutate(source => source.replace(
        "var column = fixtureColumns[i];",
        "var column = fixtureColumns[i]; detailInfo[column] = normalizeFinanceValue(detailInfo[column]);"
      ))
    }), undefined, "an extra row transformation must remain manual");

    assert.equal(financeDetailGenerationTranslation({
      handler: "compileFixtureVoucher",
      sources: mutate(source => source.replace(
        "function _DocList_AddRows(tableId, rows) {",
        "function _DocList_AddRows(tableId, rows) { rows.reverse();"
      ))
    }), undefined, "replacement must not drop source row ordering behavior");

    assert.equal(financeDetailGenerationTranslation({
      handler: "compileFixtureVoucher",
      sources: mutate(source => source
        .replace(
          "var currentAmount = $(",
          "var normalizedAmount = Number(currentAmount); var currentAmount = $("
        )
        .replace(
          "if (Number(currentAmount) > 0) data = splitFixtureRows(data, Number(currentAmount), 1, detailInfo);",
          "if (normalizedAmount > 0) data = splitFixtureRows(data, normalizedAmount, 1, detailInfo);"
        ))
    }), undefined, "amount conversion must execute after the source row value is read");

    assert.equal(financeDetailGenerationTranslation({
      handler: "compileFixtureVoucher",
      sources: mutate(source => source.replace(
        "var amount = Number(getFormFieldValue(\"fd_fixture_amount\"));",
        "var amount = Number(getFormFieldValue(\"fd_fixture_amount\")) * fixtureMultiplier;"
      )).concat({
        sourceRef: "source.form.jsp.jsp_unsupported_numeric_global.script.1",
        javascript: "var fixtureMultiplier = 2;"
      })
    }), undefined, "every closure free variable must have a supported materialized declaration");

    assert.equal(financeDetailGenerationTranslation({
      handler: "compileFixtureVoucher",
      sources: mutate(source => source.replace(
        "var fixtureFinanceTable = \"fd_fixture_finance\";",
        "var fixtureFinanceTable = \"fd_fixture_finance\"; fixtureFinanceTable = \"fd_other_finance\";"
      ))
    }), undefined, "a referenced global must not be reassigned after its declaration");

    assert.equal(financeDetailGenerationTranslation({
      handler: "compileFixtureVoucher",
      sources: mutate(source => source.replace(
        "for (var j = 0; j < rows.length; j++) DocList_AddRow(table, null, rows[j]);",
        "for (var j = 0; j < rows.length; j++) rows.reverse(); DocList_AddRow(table, null, rows[j]);"
      ))
    }), undefined, "an unbraced add loop must call DocList_AddRow immediately");

    assert.equal(financeDetailGenerationTranslation({
      handler: "compileFixtureVoucher",
      sources: mutate(source => source.replace(
        "var fixtureColumns = [",
        "var fixtureColumns = ["
      ).replace(
        "];\n    var fixtureFinanceTable",
        "]; fixtureColumns.push(\"fd_extra\");\n    var fixtureFinanceTable"
      ))
    }), undefined, "top-level array mutator calls must invalidate materialized globals");

    assert.equal(financeDetailGenerationTranslation({
      handler: "compileFixtureVoucher",
      sources: mutate(source => source.replace(
        "function compileFixtureVoucher() {",
        "function compileFixtureVoucher() { fixtureColumns[0] = \"fd_extra\";"
      ))
    }), undefined, "closure member writes must invalidate materialized globals");
  });

  it("persists the button binding and physical output-table placeholder through fake readback", async () => {
    const result = await runRouteCase("finance-detail-generation-success");
    const expected = result.dsl.scripts.actions.find(action =>
      action.functionMappings?.[0]?.basis === "deterministic-finance-detail-generation"
    );
    const actual = result.execution.readback.form.scripts.actions.find(action => action.id === expected.id);
    const prepared = prepareSample(result.dsl);
    const config = xformConfig(prepared.update);
    const formAttr = JSON.parse(config.attribute.formAttr);
    const nativeAction = formAttr.controlAction.control["mk_model_test.jsp_fixture_button"].onClick[0];

    assert.equal(result.execution.status, "written_with_warnings");
    assert.equal(actual.event, "onClick");
    assert.equal(actual.hasCanonicalGuard, true);
    assert.equal(result.execution.readback.partitions.scripts, "verified");
    assert.match(nativeAction.function, /var fixtureFinanceTable = "mk_model_test_d_[a-f0-9]+"/);
    assert.match(nativeAction.function, /MKXFORM\.setDetailValues\(fixtureFinanceTable, data\)/);
    assert.doesNotMatch(nativeAction.function, /\$\{table:/);

    const mutated = structuredClone(prepared.update);
    const mutatedConfig = xformConfig(mutated);
    const mutatedFormAttr = JSON.parse(mutatedConfig.attribute.formAttr);
    const mainModel = mutatedConfig.dataModel.find(model => model.fdType === "main");
    const buttonField = mainModel.fdFields.find(field => field.fdName === "jsp_fixture_button");
    const buttonAttribute = JSON.parse(buttonField.fdAttribute);
    const scriptToken = buttonAttribute.config.controlProps.typeCfg.operInfo;
    const language = JSON.parse(mutatedConfig.lang);
    const outputTable = nativeAction.function.match(/var fixtureFinanceTable = "([^"]+)"/)?.[1];
    const payeeTable = nativeAction.function.match(/var fixturePayeeTable = "([^"]+)"/)?.[1];
    const corrupt = source => source.replaceAll(outputTable, payeeTable);
    mutatedFormAttr.controlAction.control["mk_model_test.jsp_fixture_button"].onClick[0].function = corrupt(
      mutatedFormAttr.controlAction.control["mk_model_test.jsp_fixture_button"].onClick[0].function
    );
    language[scriptToken].content.Cn = corrupt(language[scriptToken].content.Cn);
    mutatedConfig.attribute.formAttr = JSON.stringify(mutatedFormAttr);
    mutatedConfig.lang = JSON.stringify(language);
    mutated.mechanisms["sys-xform"].fdConfig = JSON.stringify(mutatedConfig);

    const mutationReadback = prepared.verify(mutated);
    assert.equal(mutationReadback.ok, false);
    assert.equal(mutationReadback.diagnostics.some(diagnostic =>
      diagnostic.code === "readback.scripts.body_digest_mismatch"
    ), true);
  });
});
