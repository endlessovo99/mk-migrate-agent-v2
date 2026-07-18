import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const evidence = JSON.parse(readFileSync(
  join(testDir, "../fixtures/executor/persistence/calculation-native-evidence.json"),
  "utf8"
));
const sourceFixture = join(
  testDir,
  "../fixtures/route-validation/calculation-migration/route-calculation-migration_SysFormTemplate.xml"
);
const draft = draftSourceDraft(cleanSourceFile(sourceFixture));

describe("independent native calculation evidence", () => {
  it("rejects cyclic native calculation dependencies before projection", () => {
    const dsl = calculationDsl();
    const mainTotal = dsl.form.fields.find(field => field.id === evidence.dependencyCycle.leftField);
    const clamped = dsl.form.fields.find(field => field.id === evidence.dependencyCycle.rightField);
    mainTotal.props.calculation = {
      kind: "formula",
      expression: `$${evidence.dependencyCycle.rightField}$`,
      displayExpression: `$${evidence.dependencyCycle.rightField}$`,
      fieldIds: [evidence.dependencyCycle.rightField]
    };
    clamped.props.calculation = {
      kind: "formula",
      expression: `$${evidence.dependencyCycle.leftField}$`,
      displayExpression: `$${evidence.dependencyCycle.leftField}$`,
      fieldIds: [evidence.dependencyCycle.leftField]
    };

    assert.throws(
      () => prepareSample(dsl),
      error => error?.diagnostics?.some(diagnostic =>
        diagnostic.code === evidence.dependencyCycle.errorCode
      ) === true
    );
  });

  it("projects formula text, references, detail ownership, physical SUM binding, order, and event binding", () => {
    const prepared = prepareSample(calculationDsl());
    const native = nativeCalculationState(prepared.update);

    assert.deepEqual(native.order, evidence.calculationOrder);
    assertFormula(native.byRef.get(evidence.mainFormula.targetField), evidence.mainFormula);
    assertFormula(
      native.byRef.get(`${evidence.detailFormula.tableId}.${evidence.detailFormula.targetField}`),
      evidence.detailFormula
    );

    const aggregate = native.byRef.get(evidence.aggregate.targetField);
    assert.equal(aggregate.item.type, evidence.aggregate.operation);
    assert.deepEqual(aggregate.item.statisticField, [
      `${native.detailTableName}.${evidence.aggregate.sourceField}`
    ]);
    const clampAggregate = native.byRef.get(evidence.clampAggregate.targetField);
    assert.equal(clampAggregate.item.type, evidence.clampAggregate.operation);
    assert.deepEqual(clampAggregate.item.statisticField, [
      `${native.detailTableName}.${evidence.clampAggregate.sourceField}`
    ]);
    assertFormula(native.byRef.get(evidence.clampFormula.targetField), evidence.clampFormula);
    assertFormula(
      native.byRef.get(evidence.runtimeDifferenceFormula.targetField),
      evidence.runtimeDifferenceFormula
    );
    assert.equal(native.detailControl["$$tableName"], native.detailTableName);
    assert.equal(native.detailControl["$$tableType"], "detail");
    assert.equal(
      native.byRef.get(`${evidence.detailFormula.tableId}.${evidence.detailFormula.targetField}`).item.fieldKey,
      native.detailControl.id
    );

    const actionKey = `mk_model_test.${evidence.onChange.controlId}`;
    const action = native.formAttr.controlAction.control[actionKey][evidence.onChange.event][0];
    assert.equal(action.id, evidence.onChange.actionId);
    assert.deepEqual(action.migrationRunWhen, evidence.onChange.runWhen);
    assert.equal(action.function.includes(evidence.onChange.targetCall), true);
  });

  for (const testCase of [
    {
      name: "server drops a calculation rule",
      code: "readback.form.prop_calculation_mismatch",
      mutate(native) {
        native.formAttr.formRule.compute = native.formAttr.formRule.compute.filter((rule) =>
          rule.meta?.sourceFieldId !== evidence.detailFormula.targetField
        );
      }
    },
    {
      name: "server changes formula content",
      code: "readback.form.prop_calculation_mismatch",
      mutate(native) {
        native.byRef.get(evidence.mainFormula.targetField).item.value.script = "${data.biz.fd_main_left} - ${data.biz.fd_main_right}";
      }
    },
    {
      name: "server changes formula field references",
      code: "readback.form.prop_calculation_mismatch",
      mutate(native) {
        native.byRef.get(evidence.mainFormula.targetField).item.value.varIds = ["fd_main_left"];
      }
    },
    {
      name: "server changes the aggregate post-clamp formula",
      code: "readback.form.prop_calculation_mismatch",
      mutate(native) {
        native.byRef.get(evidence.clampFormula.targetField).item.value.script =
          "Math.min(${data.biz.fd_mig_raw_clamped_sum}, 0)";
      }
    },
    {
      name: "server moves a detail formula to a main control",
      code: "readback.form.prop_calculation_mismatch",
      mutate(native) {
        native.byRef.get(`${evidence.detailFormula.tableId}.${evidence.detailFormula.targetField}`).item.fieldKey =
          native.byRef.get(evidence.mainFormula.targetField).item.fieldKey;
      }
    },
    {
      name: "server changes the aggregate physical detail table",
      code: "readback.form.prop_calculation_mismatch",
      mutate(native) {
        native.byRef.get(evidence.aggregate.targetField).item.statisticField = [
          `mk_model_wrong.${evidence.aggregate.sourceField}`
        ];
      }
    },
    {
      name: "server changes the clamp helper physical detail table",
      code: "readback.form.prop_calculation_mismatch",
      mutate(native) {
        native.byRef.get(evidence.clampAggregate.targetField).item.statisticField = [
          `mk_model_wrong.${evidence.clampAggregate.sourceField}`
        ];
      }
    },
    {
      name: "server changes the detail calculation physical-table binding",
      code: "readback.form.detail_field_table_binding_mismatch",
      mutate(native) {
        native.detailControl["$$tableName"] = "mk_model_wrong";
        native.detailField.fdAttribute = JSON.stringify(native.detailAttribute);
      }
    },
    {
      name: "server changes calculation order",
      code: "readback.form.calculation_order_mismatch",
      mutate(native) {
        native.formAttr.formRule.compute.reverse();
      }
    },
    {
      name: "server drops the onChange binding",
      code: "readback.scripts.action_missing",
      mutate(native) {
        delete native.formAttr.controlAction.control[`mk_model_test.${evidence.onChange.controlId}`];
      }
    },
    {
      name: "server changes the onChange body",
      code: "readback.scripts.body_digest_mismatch",
      mutate(native) {
        const action = native.formAttr.controlAction.control[
          `mk_model_test.${evidence.onChange.controlId}`
        ][evidence.onChange.event][0];
        action.function = action.function.replace("* 2", "* 3");
      }
    }
  ]) {
    it(`returns readback_failed when ${testCase.name}`, () => {
      const prepared = prepareSample(calculationDsl());
      const template = structuredClone(prepared.update);
      const native = nativeCalculationState(template);
      testCase.mutate(native);
      persistNativeState(template, native);
      const readback = prepared.verify(template);

      assert.equal(readback.ok, false);
      assert.equal(readback.status, "readback_failed");
      assert.equal(
        readback.diagnostics.some((item) => item.code === testCase.code),
        true,
        JSON.stringify(readback.diagnostics)
      );
    });
  }
});

function calculationDsl() {
  return sampleTrustedDsl({
    form: structuredClone(draft.form),
    formRules: structuredClone(draft.formRules),
    scripts: structuredClone(draft.scripts),
    workflow: null
  });
}

function nativeCalculationState(template) {
  const config = xformConfig(template);
  const formAttr = JSON.parse(config.attribute.formAttr);
  const detailModel = config.dataModel.find((model) => model.dynamicProps?.detailFieldName === evidence.detailFormula.tableId);
  const detailField = detailModel.fdFields.find((field) => field.fdName === evidence.detailFormula.targetField);
  const detailAttribute = JSON.parse(detailField.fdAttribute);
  const detailControl = detailAttribute.config.controlProps;
  const byRef = new Map();

  for (const rule of formAttr.formRule.compute || []) {
    const item = rule.choices.items[0];
    const ref = rule.meta?.sourceTableId
      ? `${rule.meta.sourceTableId}.${rule.meta.sourceFieldId}`
      : rule.meta?.sourceFieldId;
    byRef.set(ref, { rule, item });
  }
  return {
    config,
    formAttr,
    byRef,
    order: (formAttr.formRule.compute || []).map((rule) =>
      rule.meta?.sourceTableId
        ? `${rule.meta.sourceTableId}.${rule.meta.sourceFieldId}`
        : rule.meta?.sourceFieldId
    ),
    detailModel,
    detailField,
    detailAttribute,
    detailControl,
    detailTableName: detailModel.fdTableName
  };
}

function persistNativeState(template, native) {
  native.config.attribute.formAttr = JSON.stringify(native.formAttr);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(native.config);
}

function assertFormula(actual, expected) {
  assert.equal(actual.item.type, "FORMULA");
  assert.equal(actual.item.value.type, "Eval");
  assert.equal(actual.item.value.script, expected.script);
  assert.equal(actual.item.value.vo.content, expected.display);
  assert.deepEqual(actual.item.value.varIds, expected.fieldIds);
}
