import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { draftSourceDraft, cleanSourceFile } from "../../src/translator/index.js";

const fixture = "tests/fixtures/route-validation/structural-recovery/route-structural-recovery_SysFormTemplate.xml";

describe("generic structural form recovery", () => {
  it("preserves visible controls, descriptions, table titles, nested context, and natural identities", () => {
    const source = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(source);
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const rowRefs = dsl.form.layout.sourceGrid.rows.map((row) =>
      row.cells.flatMap((cell) => cell.references.map((reference) => reference.referenceId))
    );

    assert.deepEqual(rowRefs[0], ["fd_alpha", "desc_between", "fd_beta", "desc_after"]);
    assert.equal(source.form.controls.find((field) => field.id === "fd_remote_choice")?.sourceType, "RestDialog");
    assert.equal(fields.get("fd_remote_choice")?.componentId, "xform-input");
    assert.equal(fields.get("fd_remote_choice")?.props.required, true);
    assert.equal(fields.get("fd_remote_choice")?.sourceProps.designerType, "RestDialog");
    assert.deepEqual(fields.get("fd_remote_choice")?.sourceProps.restDialog, {
      remoteConfigured: true,
      requestMethod: "GET",
      searchKey: "query",
      outputMappings: [{ outputName: "code", fieldId: "fd_alpha" }]
    });
    assert.equal(JSON.stringify(fields.get("fd_remote_choice")).includes("do-not-retain"), false);
    assert.equal(JSON.stringify(dsl).includes("password-do-not-retain"), false);
    assert.equal(JSON.stringify(dsl).includes("token-do-not-retain"), false);
    assert.equal(JSON.stringify(dsl).includes("Bearer do-not-retain"), false);
    assert.equal(dsl.review.warnings.some((item) => item.code === "source.sysform.rest_dialog_partial"), true);
    assert.equal(fields.get("fd_remote_reverse")?.componentId, "xform-input");
    assert.equal(fields.get("fd_remote_reverse")?.sourceProps.restDialog.requestMethod, "POST");

    assert.equal(fields.get("fd_detail_a")?.title, "Equipment list");
    assert.equal(fields.get("fd_detail_plain")?.title, "DetailTable2");
    assert.equal(fields.get("fd_detail_b")?.title, "Parts list");
    assert.equal(fields.get("fd_detail_c")?.title, "Service list");
    assert.equal(fields.get("fd_detail_gap")?.title, "DetailTable5");
    assert.equal(fields.get("heading_not_adjacent")?.componentId, "xform-description");
    assert.equal(fields.get("fd_detail_reverse")?.title, "DetailTable6");
    assert.equal(
      fields.get("fd_detail_reverse")?.columns.some((column) => column.id === "fd_detail_reverse_name"),
      true
    );
    assert.equal(fields.has("fd_detail_reverse_name"), false);
    assert.equal(fields.has("heading_a"), false);
    assert.equal(fields.has("heading_b"), false);
    assert.equal(fields.has("heading_c"), false);

    assert.equal(fields.get("fd_nested")?.title, "Nested visible");
    assert.deepEqual(fields.get("fd_decision")?.props.options, [
      { label: "Yes", value: "Y" },
      { label: "No", value: "N" }
    ]);
    assert.equal(fields.get("fd_hidden_scaffold")?.dataOnly, true);
    assert.equal(rowRefs.flat().includes("fd_hidden_scaffold"), false);
    assert.equal(fields.get("fd_hidden_ancestor")?.dataOnly, true);
    assert.equal(rowRefs.flat().includes("fd_hidden_ancestor"), false);
    assert.equal(source.form.controls.find((field) => field.id === "download_hint")?.sourceType, "LinkLabel");
    assert.equal(fields.get("download_hint")?.componentId, "xform-description");
    assert.equal(JSON.stringify(fields.get("download_hint")).includes("do-not-retain"), false);
    assert.equal(dsl.form.fields.filter((field) => field.id === "fd_attachment").length, 1);
    assert.equal(rowRefs.flat().filter((id) => id === "fd_attachment").length, 1);
    assert.deepEqual(rowRefs.at(-1), ["recovered_download_hint", "fd_recovered_attachment"]);
    assert.equal(fields.get("recovered_download_hint")?.componentId, "xform-description");
    assert.equal(fields.get("fd_recovered_attachment")?.componentId, "xform-attach");
    assert.equal(fields.has("fd_detail_attach"), false);
    assert.equal(
      fields.get("fd_detail_a")?.columns.some((column) => column.id === "fd_detail_attach"),
      true
    );
  });

  it("keeps the route fixture free of acceptance-template identifiers", () => {
    const xml = readFileSync(fixture, "utf8");
    assert.doesNotMatch(xml, /1927955f6e544383f46970f48468a743|1jtckfnf9w6hw4ktrw3ngnr6033lm23r15w0|商务投标探路报价申请/);
  });
});
