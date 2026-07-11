import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { preparePersistedTemplate } from "../../src/executor/persistence.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("detail runtime persistence contract", () => {
  it("projects native-compatible metadata for detail business fields", () => {
    const { detailModel } = projectDetailModel({
      templateId: "template-metadata",
      mainTableName: "mk_runtime_metadata"
    });
    const businessFields = detailModel.fdFields.filter((field) => field.fdIsSystem !== true);

    assert.equal(businessFields.length > 0, true);
    assert.equal(detailModel.fdTableName.length <= 30, true);
    assert.deepEqual(
      businessFields.map((field) => ({
        id: field.fdName,
        mechanismType: field.fdMechanismType,
        hasSyntheticColumn: Object.hasOwn(field, "fdColumn")
      })),
      businessFields.map((field) => ({
        id: field.fdName,
        mechanismType: "SYS-XFORM",
        hasSyntheticColumn: false
      }))
    );
  });

  it("keeps submitted detail business values after a runtime round-trip", () => {
    const { detailModel } = projectDetailModel({
      templateId: "template-runtime",
      mainTableName: "mk_runtime_main"
    });
    const submittedRow = {
      fd_id: "detail-row-1",
      fd_main_id: "main-row-1",
      fd_order: 1,
      fd_name: "风场 A"
    };

    const persistedRow = persistLikeNewOaRuntime(detailModel, submittedRow);

    assert.deepEqual(persistedRow, submittedRow);
  });

  it("derives each detail physical table from its server-generated main table", () => {
    const firstMainTable = "mk_main_alpha";
    const secondMainTable = "mk_main_beta";
    const first = projectDetailModel({
      templateId: "template-alpha",
      mainTableName: firstMainTable
    });
    const second = projectDetailModel({
      templateId: "template-beta",
      mainTableName: secondMainTable
    });

    assert.deepEqual({
      firstUsesServerMain: first.detailModel.fdTableName.startsWith(`${firstMainTable}_`),
      secondUsesServerMain: second.detailModel.fdTableName.startsWith(`${secondMainTable}_`),
      physicalTablesAreIsolated: first.detailModel.fdTableName !== second.detailModel.fdTableName
    }, {
      firstUsesServerMain: true,
      secondUsesServerMain: true,
      physicalTablesAreIsolated: true
    });
  });

  it("isolates long main tables that share the same truncated prefix", () => {
    const sharedPrefix = "mk_model_shared_prefix_that_exceeds_the_native_limit_";
    const first = projectDetailModel({
      templateId: "template-long-alpha",
      mainTableName: `${sharedPrefix}alpha`
    });
    const second = projectDetailModel({
      templateId: "template-long-beta",
      mainTableName: `${sharedPrefix}beta`
    });

    assert.notEqual(first.detailModel.fdTableName, second.detailModel.fdTableName);
    assert.equal(first.detailModel.fdTableName.length <= 30, true);
    assert.equal(second.detailModel.fdTableName.length <= 30, true);
  });

  it("uses the complete server table identity when normalized names collide", () => {
    const first = projectDetailModel({
      templateId: "template-punctuation-alpha",
      mainTableName: "mk_runtime-main"
    });
    const second = projectDetailModel({
      templateId: "template-punctuation-beta",
      mainTableName: "mk_runtime_main"
    });

    assert.notEqual(first.detailModel.fdTableName, second.detailModel.fdTableName);
  });
});

function projectDetailModel({ templateId, mainTableName }) {
  const templateName = `MK_TEST_detail_contract_${templateId}`;
  const dsl = sampleTrustedDsl();
  delete dsl.workflow;
  const prepared = preparePersistedTemplate({
    dsl,
    envelope: {
      templateId,
      templateName,
      categoryId: "category-id",
      tableName: mainTableName,
      lifecycle: {
        draft: true,
        unpublished: true,
        fdStatus: 0,
        xformStatus: "draft"
      },
      bindings: { formFdId: templateId }
    },
    baseTemplate: {
      fdId: templateId,
      fdName: templateName,
      fdStatus: 0,
      fdTableName: mainTableName,
      fdCategory: { fdId: "category-id" },
      mechanisms: {
        "sys-xform": {
          fdId: templateId,
          fdName: templateName,
          fdTableName: mainTableName,
          fdConfig: "{}"
        }
      }
    }
  });
  if (!prepared.ok) {
    throw new Error(prepared.diagnostics.map((item) => item.message).join("; "));
  }

  const config = JSON.parse(prepared.update.mechanisms["sys-xform"].fdConfig);
  const detailModel = config.dataModel.find((model) =>
    model.fdType === "detail" && model.dynamicProps?.detailFieldName === "fd_detail"
  );
  if (!detailModel) throw new Error("Projected template is missing fd_detail metadata.");
  return { detailModel };
}

/**
 * Minimal model of the observed NewOA add/get behavior: row identity survives,
 * while business values survive only for SYS-XFORM fields.
 */
function persistLikeNewOaRuntime(detailModel, submittedRow) {
  return Object.fromEntries(
    detailModel.fdFields
      .filter((field) => field.fdIsSystem || field.fdMechanismType === "SYS-XFORM")
      .filter((field) => Object.hasOwn(submittedRow, field.fdName))
      .map((field) => [field.fdName, submittedRow[field.fdName]])
  );
}
