import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

describe("detail persistence readback contract", () => {
  it("recovers the DSL detail id from fdAttribute when the server strips dynamicProps", () => {
    const readback = verifyMutated((config) => {
      const detail = detailModel(config);
      const opaqueTableName = "mk_detail_opaque_7f3a";
      const renamed = JSON.parse(
        JSON.stringify(config).replaceAll(detail.fdTableName, opaqueTableName)
      );
      const renamedDetail = detailModel(renamed);
      delete renamedDetail.dynamicProps;
      for (const field of businessFields(renamedDetail)) {
        field.fdMechanismType = "SYS-XFORM";
      }
      return renamed;
    });

    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.form.fields.some((field) => field.id === "fd_detail"), true);
  });

  it("rejects a detail business field with a non-SYS-XFORM mechanism", () => {
    const readback = verifyMutated((config) => {
      businessFields(detailModel(config))[0].fdMechanismType = "KmReviewDetail";
      return config;
    });

    assert.equal(readback.ok, false);
    assert.equal(hasCode(readback, "readback.form.detail_field_mechanism_type_mismatch"), true);
  });

  it("rejects a synthetic physical column on a detail business field", () => {
    const readback = verifyMutated((config) => {
      businessFields(detailModel(config))[0].fdColumn = "fd_fd_name";
      return config;
    });

    assert.equal(readback.ok, false);
    assert.equal(hasCode(readback, "readback.form.detail_field_column_mismatch"), true);
  });

  it("rejects a detail business field bound to another data model", () => {
    const readback = verifyMutated((config) => {
      businessFields(detailModel(config))[0].fdDataModel = {
        fdId: "another-model-id",
        fdName: "另一个明细模型"
      };
      return config;
    });

    assert.equal(readback.ok, false);
    assert.equal(hasCode(readback, "readback.form.detail_field_model_binding_mismatch"), true);
  });

  it("rejects native detail controls bound to a different physical table", () => {
    const readback = verifyMutated((config) => {
      const detail = detailModel(config);
      const modelAttribute = JSON.parse(detail.fdAttribute);
      modelAttribute.config.controlProps["$$tableName"] = "wrong_detail_table";
      detail.fdAttribute = JSON.stringify(modelAttribute);

      const field = businessFields(detail)[0];
      const fieldAttribute = JSON.parse(field.fdAttribute);
      fieldAttribute.config.controlProps["$$tableName"] = "wrong_detail_table";
      field.fdAttribute = JSON.stringify(fieldAttribute);
      return config;
    });

    assert.equal(readback.ok, false);
    assert.equal(hasCode(readback, "readback.form.detail_model_binding_mismatch"), true);
    assert.equal(hasCode(readback, "readback.form.detail_field_table_binding_mismatch"), true);
  });

  it("rejects a physical detail table reused by the main model", () => {
    const readback = verifyMutated((config) => {
      const main = config.dataModel.find((model) => model.fdType === "main");
      detailModel(config).fdTableName = main.fdTableName;
      return config;
    });

    assert.equal(readback.ok, false);
    assert.equal(hasCode(readback, "readback.form.detail_table_cross_model_conflict"), true);
  });
});

function verifyMutated(mutateConfig) {
  const prepared = prepareSample(sampleTrustedDsl({ workflow: null }));
  const template = structuredClone(prepared.update);
  const config = mutateConfig(xformConfig(template));
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  return prepared.verify(template);
}

function detailModel(config) {
  return config.dataModel.find((model) => model.fdType === "detail");
}

function businessFields(detail) {
  return detail.fdFields.filter((field) => field.fdIsSystem !== true);
}

function hasCode(readback, code) {
  return readback.diagnostics.some((item) => item.code === code);
}
