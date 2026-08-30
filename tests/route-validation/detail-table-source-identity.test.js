import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { projectTemplate, xformConfig } from "../helpers/persistence.js";

const fixture = "tests/fixtures/source2/1790be7c892fe3023c8de49407782b79";

const expectedDetails = [
  { id: "fd_37b043b6560188", name: "业务招待" },
  { id: "fd_37b058dbdb8e54", name: "费用报销" },
  { id: "fd_37b05a1bb4751e", name: "行程明细" },
  { id: "fd_37b0d83b385242", name: "其他费用" },
  { id: "fd_37b0d9407abeee", name: "市内交通" },
  { id: "fd_37b0d944369540", name: "加班餐费" }
];

describe("EKP detail-table identity Route case", () => {
  it("uses each EKP detail fdId as the MK detail code and physical table identity", () => {
    const source = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(source);

    assert.equal(dsl.template.name, "费用报销（对私-项目）的拷贝的拷贝2");
    assert.deepEqual(
      dsl.form.fields
        .filter((field) => field.type === "detailTable")
        .map((field) => ({ id: field.id, name: field.title })),
      expectedDetails
    );

    const template = projectTemplate(dsl);
    const detailModels = xformConfig(template).dataModel.filter((model) => model.fdType === "detail");

    assert.deepEqual(
      detailModels.map((model) => {
        const control = JSON.parse(model.fdAttribute).config.controlProps;
        return {
          name: model.fdName,
          code: model.dynamicProps?.detailFieldName,
          tableName: model.fdTableName,
          tableNameAlias: model.fdTableNameAlias,
          controlCode: control["$$detailTableFieldName"],
          controlTableName: control["$$tableName"]
        };
      }),
      expectedDetails.map(({ id, name }) => ({
        name,
        code: id,
        tableName: `mk_model_${id}`,
        tableNameAlias: `mk_model_${id}`,
        controlCode: id,
        controlTableName: `mk_model_${id}`
      }))
    );
  });
});
