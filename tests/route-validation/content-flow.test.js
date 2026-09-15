import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { renderNativeFieldReferences } from "../helpers/native-form-renderer.js";

const fixture = "tests/fixtures/translator/content-flow/content-flow_SysFormTemplate.xml";

describe("mixed cell content Route-validation", () => {
  it("renders every mixed-cell field through NewOA's registered container traversal", () => {
    const source = cleanSourceFile(fixture);
    const trusted = createTrustedMigrationDsl(source, draftSourceDraft(source), { externalAgentReviewed: true });
    const prepared = prepareSample(trusted);
    for (const scene of ["desktop", "mobile"]) {
      const rendered = renderNativeFieldReferences(xformConfig(prepared.update), scene);
      assert.ok(rendered.expected.length > 0);
      assert.deepEqual(rendered.actual, rendered.expected);
      const broken = xformConfig(prepared.update);
      const view = JSON.parse(broken.viewModel[0].fdConfig);
      function restoreUnregisteredContainers(node) {
        if (node.type === "div") node.type = "@elem/flex";
        node.children?.forEach(restoreUnregisteredContainers);
      }
      restoreUnregisteredContainers(view.view.render[scene][0]);
      broken.viewModel[0].fdConfig = JSON.stringify(view);
      const missing = renderNativeFieldReferences(broken, scene);
      assert.ok(missing.actual.length < missing.expected.length);
    }
  });
  it("preserves source breaks and widths through DSL and native persistence for mixed controls", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
    assert.equal(checkTrust(source, trusted).ok, true);
    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    const cells = readback.form.layoutRows.flatMap((row) => row.cells);
    const mixed = cells.find((cell) => cell.fieldIds.includes("fd_start"));
    assert.deepEqual(mixed.contentFlow.lines, [
      ["lead", "fd_start", "middle", "fd_end", "tail"],
      ["fd_code", "suffix"], [], ["note", "fd_last", "after"]
    ]);
    assert.deepEqual(mixed.contentFlow.items.find((item) => item.referenceId === "fd_start").width, { value: 120, unit: "px" });
    assert.deepEqual(mixed.contentFlow.items.find((item) => item.referenceId === "fd_end").width, { value: 40, unit: "%" });
    const units = cells.find((cell) => cell.fieldIds.includes("fd_amount"));
    assert.deepEqual(units.contentFlow.lines, [["fd_amount"], ["fd_total", "total_unit"]]);
    assert.equal(readback.form.fields.find((field) => field.id === "fd_amount").unit, "元");
    assert.equal(readback.form.fields.find((field) => field.id === "total_unit").content, "天");
    assert.deepEqual(readback.form.fields.find((field) => field.id === "fd_total").calculation.fieldIds, ["fd_amount"]);
  });

  it("applies the same flow rules after all source ids and business text change", () => {
    const xml = readFileSync(fixture, "utf8").replace(/\bfd_(?!type\b|values\b)/g, "xx_")
      .replaceAll("范围", "区间").replaceAll("元", "吨").replaceAll("天", "小时");
    const original = translateSysFormTemplateXml(readFileSync(fixture, "utf8"));
    const changed = translateSysFormTemplateXml(xml);
    const normalize = (layout) => JSON.parse(JSON.stringify(layout).replaceAll("xx_", "fd_"));
    assert.deepEqual(normalize(changed.form.layout.rows.map((row) => row.cells.map((cell) => cell.contentFlow))),
      original.form.layout.rows.map((row) => row.cells.map((cell) => cell.contentFlow)));
  });
});
