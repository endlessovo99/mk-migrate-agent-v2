import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildFormRuleRefIndex, resolveEffectTarget } from "../../src/dsl/form-rules.js";
import { draftSourceDraft, cleanSourceFile } from "../../src/translator/index.js";

const fixture = "tests/fixtures/route-validation/structural-recovery/route-structural-recovery_SysFormTemplate.xml";
const duplicateAttachmentFixture =
  "tests/fixtures/route-validation/structural-recovery/route-structural-recovery-duplicate-attachment_SysFormTemplate.xml";
const inlineContentFixture =
  "tests/fixtures/route-validation/structural-recovery/route-structural-recovery-inline-content_SysFormTemplate.xml";
const structuralFixtures = [fixture, duplicateAttachmentFixture, inlineContentFixture];
const forbiddenAcceptanceEvidence =
  /1927955f6e544383f46970f48468a743|1jtckfnf9w6hw4ktrw3ngnr6033lm23r15w0|fd_3ee52ece20de5a|\bN(?:67|68|91)\b|\bL103\b|商务投标探路报价申请/;

describe("generic structural form recovery", () => {
  it("preserves visible controls, descriptions, table titles, nested context, and natural identities", () => {
    const source = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(source);
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const rowRefs = dsl.form.layout.sourceGrid.rows.map((row) =>
      row.cells.flatMap((cell) => cell.references.map((reference) => reference.referenceId))
    );
    const mkTreeRefs = dsl.form.layout.mkTree.map((row) =>
      row.children.flatMap((cell) => cell.refIds)
    );

    assert.deepEqual(rowRefs[0], ["fd_alpha", "desc_between", "fd_beta", "desc_after"]);
    assert.deepEqual(mkTreeRefs[0], ["fd_alpha", "desc_between", "fd_beta", "desc_after"]);
    assert.equal(source.form.controls.find((field) => field.id === "fd_remote_choice")?.sourceType, "RestDialog");
    assert.equal(fields.get("fd_remote_choice")?.title, "Remote choice");
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
    assert.equal(fields.get("fd_detail_cross_row")?.title, "Cross-row equipment list");
    assert.equal(fields.has("heading_cross_row"), false);
    assert.equal(fields.get("fd_detail_follow")?.title, "DetailTable8");
    assert.equal(fields.get("fd_detail_twin_a")?.title, "DetailTable9");
    assert.equal(fields.get("fd_detail_twin_b")?.title, "DetailTable10");
    assert.equal(fields.get("heading_shared_ambiguous")?.componentId, "xform-description");
    assert.equal(fields.get("heading_shared_ambiguous")?.props.content, "Ambiguous shared heading");

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
    assert.equal(fields.get("recovered_download_hint")?.props.content, "Download recovered template");
    assert.equal(fields.get("fd_recovered_attachment")?.componentId, "xform-attach");
    assert.equal(fields.has("fd_detail_attach"), false);
    assert.equal(
      fields.get("fd_detail_a")?.columns.some((column) => column.id === "fd_detail_attach"),
      true
    );
    assert.equal(fields.get("fd_visibility_collision")?.title, "Visible business field");
    assert.notEqual(fields.get("fd_visibility_collision")?.dataOnly, true);
    assert.equal(rowRefs.flat().filter((id) => id === "fd_visibility_collision").length, 1);
  });

  it("uses true multi-level nesting and keeps every structural fixture free of acceptance identifiers", () => {
    const xml = readFileSync(fixture, "utf8");
    assert.match(xml, /layout-wrapper-level-two[\s\S]*layout-wrapper-level-three/);
    for (const fixturePath of structuralFixtures) {
      assert.doesNotMatch(readFileSync(fixturePath, "utf8"), forbiddenAcceptanceEvidence, fixturePath);
    }
  });

  it("normalizes ordinal-suffixed compound controls from adjacent inline captions", () => {
    const source = cleanSourceFile(inlineContentFixture);
    const dsl = draftSourceDraft(source);
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const sourceRow = dsl.form.layout.sourceGrid.rows.find((row) =>
      row.cells.some((cell) =>
        cell.references.some((reference) => reference.referenceId === "fd_region_province")
      )
    );
    const mkRow = dsl.form.layout.mkTree.find((row) =>
      row.children.some((cell) => cell.refIds.includes("fd_region_province"))
    );

    assert.equal(fields.get("fd_region_province")?.sourceProps.designerValues.label, "Province1");
    assert.equal(fields.get("fd_region_city")?.sourceProps.designerValues.label, "City2");
    assert.deepEqual(fields.get("fd_region_province")?.sourceProps.inlineCaption, {
      id: "region_province_suffix",
      content: "Province",
      relation: "trailing-ordinal-caption"
    });
    assert.equal(fields.get("fd_region_province")?.sourceProps.metadataId, "meta_region_province");
    assert.equal(fields.get("fd_region_province")?.type, "dateTime");
    assert.equal(fields.get("fd_region_province")?.props.required, true);
    assert.equal(fields.get("fd_region_province")?.title, "Province");
    assert.equal(fields.get("fd_region_city")?.title, "City");
    assert.equal(fields.has("region_province_suffix"), false);
    assert.equal(fields.has("region_city_suffix"), false);
    assert.deepEqual(
      sourceRow?.cells.flatMap((cell) => cell.references.map((reference) => reference.referenceId)),
      ["fd_region_province", "fd_region_city"]
    );
    assert.deepEqual(
      mkRow?.children.map((cell) => cell.refIds),
      [["fd_region_province"], ["fd_region_city"]]
    );
  });

  it("folds an unambiguous post-break styled hint into the owning input placeholder", () => {
    const source = cleanSourceFile(inlineContentFixture);
    const dsl = draftSourceDraft(source);
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const sourceRow = dsl.form.layout.sourceGrid.rows.find((row) =>
      row.cells.some((cell) =>
        cell.references.some((reference) => reference.referenceId === "fd_opportunity")
      )
    );
    const mkRow = dsl.form.layout.mkTree.find((row) =>
      row.children.some((cell) => cell.refIds.includes("fd_opportunity"))
    );
    const hint = "Example: REF-123; enter NONE if unavailable";

    assert.equal(fields.get("fd_opportunity")?.componentId, "xform-input");
    assert.equal(fields.get("fd_opportunity")?.props.placeholder, hint);
    assert.deepEqual(fields.get("fd_opportunity")?.sourceProps.inlineCaption, {
      id: "opportunity_inline_caption",
      content: "Opportunity ID",
      relation: "leading-title-segment"
    });
    assert.deepEqual(fields.get("fd_opportunity")?.sourceProps.inlineHint, {
      id: "opportunity_hint",
      content: hint,
      relation: "post-break-styled-text"
    });
    assert.equal(fields.has("opportunity_hint"), false);
    assert.equal(fields.has("opportunity_inline_caption"), false);
    assert.deepEqual(
      sourceRow?.cells.flatMap((cell) => cell.references.map((reference) => reference.referenceId)),
      ["fd_opportunity"]
    );
    assert.deepEqual(mkRow?.children.map((cell) => cell.refIds), [["fd_opportunity"]]);
  });

  it("folds the same direct styled hint pattern into textarea placeholder capability", () => {
    const dsl = draftSourceDraft(cleanSourceFile(inlineContentFixture));
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const note = fields.get("fd_long_note");

    assert.equal(note?.componentId, "xform-textarea");
    assert.equal(note?.props.placeholder, "Explain the exception in detail");
    assert.deepEqual(note?.sourceProps.inlineHint, {
      id: "long_note_hint",
      content: "Explain the exception in detail",
      relation: "post-break-styled-text"
    });
    assert.equal(fields.has("long_note_hint"), false);
  });

  it("keeps a hint standalone when metadata refines the owner to a component without placeholder support", () => {
    const dsl = draftSourceDraft(cleanSourceFile(inlineContentFixture));
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));

    assert.equal(fields.get("fd_metadata_date")?.componentId, "xform-datetime");
    assert.equal(fields.get("fd_metadata_date")?.props.placeholder, undefined);
    assert.equal(fields.get("metadata_date_hint")?.componentId, "xform-description");
    assert.equal(fields.get("metadata_date_hint")?.props.content, "Choose the contractual date");
  });

  it("uses the shared final component rule before folding an element-property hint", () => {
    const dsl = draftSourceDraft(cleanSourceFile(inlineContentFixture));
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));

    assert.equal(fields.get("fd_metadata_address")?.componentId, "xform-address");
    assert.equal(fields.get("fd_metadata_address")?.props.placeholder, undefined);
    assert.equal(fields.get("metadata_address_hint")?.componentId, "xform-description");
    assert.equal(fields.get("metadata_address_hint")?.props.content, "Select an organization");
  });

  it("does not attach a styled description across an unsupported intervening control", () => {
    const dsl = draftSourceDraft(cleanSourceFile(inlineContentFixture));
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));

    assert.equal(fields.get("fd_guarded_hint")?.props.placeholder, undefined);
    assert.equal(fields.get("guarded_hint")?.componentId, "xform-description");
  });

  it("keeps four real controls in one four-column row after removing inline range captions", () => {
    const source = cleanSourceFile(inlineContentFixture);
    const dsl = draftSourceDraft(source);
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const dateIds = ["fd_delivery_start", "fd_delivery_end", "fd_bid_date", "fd_visit_date"];
    const sourceRow = dsl.form.layout.sourceGrid.rows.find((row) =>
      row.cells.some((cell) =>
        cell.references.some((reference) => reference.referenceId === "fd_delivery_start")
      )
    );
    const mkRow = dsl.form.layout.mkTree.find((row) =>
      row.children.some((cell) => cell.refIds.includes("fd_delivery_start"))
    );

    assert.deepEqual(
      sourceRow?.cells.flatMap((cell) => cell.references.map((reference) => reference.referenceId)),
      dateIds
    );
    assert.equal(fields.has("delivery_start_caption"), false);
    assert.equal(fields.has("delivery_end_caption"), false);
    assert.equal(fields.get("fd_delivery_start")?.title, "Delivery window - Start");
    assert.equal(fields.get("fd_delivery_end")?.title, "Delivery window - End");
    assert.equal(mkRow?.componentId, "xform-flex-1-4-layout");
    assert.equal(mkRow?.props.columns, 4);
    assert.equal(mkRow?.children.length, 4);
    assert.deepEqual(mkRow?.children.map((cell) => cell.refIds), dateIds.map((id) => [id]));
    assert.deepEqual(mkRow?.children.map((cell) => cell.column), [0, 1, 2, 3]);
    assert.equal(mkRow?.children.every((cell) => cell.colspan === 1), true);
  });

  it("reflows a source row with more than four controls and preserves its marker target", () => {
    const dsl = draftSourceDraft(cleanSourceFile(inlineContentFixture));
    const ids = [
      "fd_slot_alpha",
      "fd_slot_bravo",
      "fd_slot_charlie",
      "fd_slot_delta",
      "fd_slot_echo"
    ];
    const rows = dsl.form.layout.mkTree.filter((row) =>
      row.sourceMarkers?.includes("fd_overflow_row")
    );
    const row = rows[0];
    const markerTarget = resolveEffectTarget(buildFormRuleRefIndex(dsl.form), "fd_overflow_row");

    assert.equal(rows.length, 1);
    assert.equal(row.componentId, "xform-multi-row-table-layout");
    assert.deepEqual(row.props, { rows: 2, columns: 4 });
    assert.equal(row.children.length, 5);
    assert.deepEqual(row.children.flatMap((cell) => cell.refIds), ids);
    assert.deepEqual(row.children.map((cell) => cell.row), [0, 0, 0, 0, 1]);
    assert.deepEqual(row.children.map((cell) => cell.column), [0, 1, 2, 3, 0]);
    assert.deepEqual(markerTarget?.targets.map((target) => target.id), ids);
    assert.equal(row.children.every((cell) => cell.row * row.props.columns + cell.column < 8), true);
  });

  it("deduplicates recovered attachment candidates by natural source ID in wrapper order", () => {
    const source = cleanSourceFile(duplicateAttachmentFixture);
    const dsl = draftSourceDraft(source);
    const matchingFields = dsl.form.fields.filter((field) => field.id === "fd_shared_attachment");
    const matchingLayoutRefs = dsl.form.layout.sourceGrid.rows
      .flatMap((row) => row.cells)
      .flatMap((cell) => cell.references)
      .filter((reference) => reference.referenceId === "fd_shared_attachment");
    const recoveredRow = dsl.form.layout.sourceGrid.rows.at(-1);

    assert.equal(matchingFields.length, 1);
    assert.equal(matchingFields[0]?.title, "First attachment");
    assert.equal(dsl.form.fields.find((field) => field.id === "download_hint")?.props.content, "Download template");
    assert.equal(matchingLayoutRefs.length, 1);
    assert.deepEqual(
      recoveredRow.cells[0].references.map((reference) => reference.referenceId),
      ["download_hint", "fd_shared_attachment"]
    );
  });

  it("removes only same-title cross-cell labels without deleting real descriptions", () => {
    const source = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(source);
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const rowRefs = dsl.form.layout.sourceGrid.rows.map((row) =>
      row.cells.flatMap((cell) => cell.references.map((reference) => reference.referenceId))
    );

    assert.equal(fields.has("bound_field_label"), false);
    assert.equal(fields.get("fd_bound_value")?.title, "Bound field");
    assert.deepEqual(rowRefs.find((references) => references.includes("fd_bound_value")), ["fd_bound_value"]);

    assert.equal(fields.get("unbound_same_title")?.componentId, "xform-description");
    assert.equal(fields.get("fd_shared_wording")?.componentId, "xform-input");
    assert.deepEqual(
      rowRefs.find((references) => references.includes("fd_shared_wording")),
      ["unbound_same_title", "fd_shared_wording"]
    );

    assert.equal(fields.get("different_bound_caption")?.componentId, "xform-description");
    assert.equal(fields.get("fd_machine_named_value")?.componentId, "xform-input");
    assert.equal(fields.get("fd_machine_named_value")?.title, "Machine field 1");
    assert.deepEqual(
      rowRefs.find((references) => references.includes("fd_machine_named_value")),
      ["different_bound_caption", "fd_machine_named_value"]
    );

    assert.equal(fields.get("detail_companion_caption")?.componentId, "xform-description");
    assert.equal(fields.get("fd_detail_companion_total")?.componentId, "xform-input");
    assert.deepEqual(
      rowRefs.find((references) => references.includes("fd_detail_companion_total")),
      ["fd_detail_with_caption", "detail_companion_caption", "fd_detail_companion_total"]
    );
  });
});
