import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";

describe("translateSysFormTemplateXml", () => {
  it("translates a SysFormTemplate XML fixture into valid DSL", () => {
    const sourcePath = "tests/fixtures/source/sysform-fixture-id_SysFormTemplate.xml";
    const xml = readFileSync(sourcePath, "utf8");
    const dsl = translateSysFormTemplateXml(xml, { sourcePath });
    const validation = validateMigrationDsl(dsl);
    const byId = new Map(dsl.form.fields.map((field) => [field.id, field]));

    assert.equal(dsl.source.kind, "sysform-template-xml");
    assert.equal(dsl.source.fdId, "sysform-fixture-id");
    assert.equal(dsl.template.name, "示例表单");
    assert.equal(byId.get("fd_type")?.type, "singleSelect");
    assert.deepEqual(byId.get("fd_type")?.options, [
      { label: "固废", value: "A" },
      { label: "其他", value: "B" }
    ]);

    const detailTable = byId.get("fd_detail");
    assert.equal(detailTable?.type, "detailTable");
    assert.deepEqual(detailTable.columns.map((column) => [column.id, column.title, column.type]), [
      ["fd_name", "固废名称", "text"],
      ["fd_amount", "数量", "number"]
    ]);
    assert.equal(validation.ok, true);
  });
});
