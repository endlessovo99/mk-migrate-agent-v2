import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { preparePersistedTemplate } from "../../src/executor/persistence.js";
import { detailTableNameFor } from "../../src/executor/persistence/detail-table-names.js";
import { isPhysicalDetailTableAuthKey } from "../../src/executor/persistence/detail-auth.js";
import { applyFormPayload } from "../../src/executor/persistence/form-writer.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("detail persistence metadata contract", () => {
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

  it("marks submitted detail business values as platform-managed fields", () => {
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

    const persistableRow = selectPlatformManagedDetailValues(detailModel, submittedRow);

    assert.deepEqual(persistableRow, submittedRow);
  });

  it("derives the detail physical table from its EKP detail fdId", () => {
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

    assert.equal(first.detailModel.fdTableName, "fd_detail");
    assert.equal(second.detailModel.fdTableName, "fd_detail");
    assert.equal(first.detailModel.dynamicProps.detailFieldName, "fd_detail");
    assert.equal(second.detailModel.dynamicProps.detailFieldName, "fd_detail");
  });

  it("does not let long main-table identities alter the source-derived detail table", () => {
    const sharedPrefix = "mk_model_shared_prefix_that_exceeds_the_native_limit_";
    const first = projectDetailModel({
      templateId: "template-long-alpha",
      mainTableName: `${sharedPrefix}alpha`
    });
    const second = projectDetailModel({
      templateId: "template-long-beta",
      mainTableName: `${sharedPrefix}beta`
    });

    assert.equal(first.detailModel.fdTableName, "fd_detail");
    assert.equal(second.detailModel.fdTableName, "fd_detail");
  });

  it("does not let normalized main-table collisions alter the source-derived detail table", () => {
    const first = projectDetailModel({
      templateId: "template-punctuation-alpha",
      mainTableName: "mk_runtime-main"
    });
    const second = projectDetailModel({
      templateId: "template-punctuation-beta",
      mainTableName: "mk_runtime_main"
    });

    assert.equal(first.detailModel.fdTableName, "fd_detail");
    assert.equal(second.detailModel.fdTableName, "fd_detail");
  });

  it("uses the same physical name for the same fdId across main tables", () => {
    const sharedPrefix = "mk_model_shared_prefix_that_exceeds_the_native_limit_";
    const fieldId = "fd_detail";
    const first = detailTableNameFor(`${sharedPrefix}alpha`, fieldId);
    const second = detailTableNameFor(`${sharedPrefix}beta`, fieldId);

    assert.equal(first, "fd_detail");
    assert.equal(second, "fd_detail");
  });

  it("isolates detail field identities within the same main table", () => {
    const mainTableName = "mk_model_shared_main_table";
    const first = detailTableNameFor(mainTableName, "fd_detail_alpha");
    const second = detailTableNameFor(mainTableName, "fd_detail_beta");

    assert.notEqual(first, second);
  });

  it("preserves a non-standard detail id without normalization", () => {
    const normalized = detailTableNameFor("mk_model_main", "fd_a");
    const nonStandard = detailTableNameFor("mk_model_main", "fd-a");
    const whitespace = detailTableNameFor("mk_model_main", " fd-a ");

    assert.equal(normalized, "fd_a");
    assert.equal(nonStandard, "fd-a");
    assert.equal(whitespace, " fd-a ");
  });

  it("classifies detail authority with the exact projected model table set", () => {
    const detailTables = new Set(["mk_model_items"]);

    assert.equal(isPhysicalDetailTableAuthKey("mk_model_items", detailTables), true);
    assert.equal(isPhysicalDetailTableAuthKey("mk_model_fd_status", detailTables), false);
  });

  it("fails before persistence when projected table names collide case-insensitively", () => {
    const dsl = sampleTrustedDsl();
    delete dsl.workflow;
    const first = dsl.form.fields.find((field) => field.type === "detailTable");
    first.id = "fd_A";
    const second = structuredClone(first);
    second.id = "fd_a";
    second.title = "另一张明细";
    second.columns[0].id = "fd_other_name";
    dsl.form.fields.push(second);

    assert.throws(
      () => applyFormPayload({
        fdId: "template-table-collision",
        fdName: "MK_TEST_table_collision",
        fdTableName: "mk_model_main",
        mechanisms: {
          "sys-xform": {
            fdId: "template-table-collision",
            fdName: "MK_TEST_table_collision",
            fdTableName: "mk_model_main",
            fdConfig: "{}"
          }
        }
      }, dsl),
      (error) => error?.code === "projection.form.native_table_name_collision"
    );
  });

  it("does not silently shorten a long detail identity", () => {
    const sourceId = "fd_detail_identity_that_exceeds_the_native_limit";
    const tableName = detailTableNameFor(
      "mk_model_shared_prefix_that_exceeds_the_native_limit_alpha",
      sourceId
    );

    assert.equal(tableName, sourceId);
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
 * Selects values backed by platform-managed field metadata. This verifies the
 * writer contract only; the real add/get behavior is verified separately in SIT.
 */
function selectPlatformManagedDetailValues(detailModel, submittedRow) {
  return Object.fromEntries(
    detailModel.fdFields
      .filter((field) => field.fdIsSystem || field.fdMechanismType === "SYS-XFORM")
      .filter((field) => Object.hasOwn(submittedRow, field.fdName))
      .map((field) => [field.fdName, submittedRow[field.fdName]])
  );
}
