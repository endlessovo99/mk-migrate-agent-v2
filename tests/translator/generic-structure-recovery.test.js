import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildFormRuleRefIndex, resolveEffectTarget } from "../../src/dsl/form-rules.js";
import { applyAdjacentDetailTableTitles } from "../../src/translator/designer-structure-recovery.js";
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

  it("merges one structurally owned styled note into a detail-table title without whitespace", () => {
    const source = cleanSourceFile(inlineContentFixture);
    const dsl = draftSourceDraft(source);
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const title = "Assembly parts(Copyflowthenregenerateparts)";
    const sourceRow = dsl.form.layout.sourceGrid.rows.find((row) =>
      row.cells.some((cell) =>
        cell.references.some((reference) => reference.referenceId === "fd_parts_table")
      )
    );
    const mkRow = dsl.form.layout.mkTree.find((row) =>
      row.children.some((cell) => cell.refIds.includes("fd_parts_table"))
    );

    assert.equal(fields.get("fd_parts_table")?.title, title);
    assert.equal(fields.get("fd_parts_table")?.title.includes("( "), false);
    assert.equal(fields.get("fd_parts_table")?.title.includes(" )"), false);
    assert.deepEqual(fields.get("fd_parts_table")?.sourceProps.detailTitleHint, {
      id: "parts_table_hint",
      content: "Copy flow then regenerate parts",
      rawContent: " Copy flow then regenerate parts ",
      designerValues: {
        id: "parts_table_hint",
        content: " Copy flow then regenerate parts ",
        color: "#FF0000",
        b: "false"
      },
      relation: "post-heading-break-styled-text-before-detail-table"
    });
    assert.equal(fields.has("parts_table_heading"), false);
    assert.equal(fields.has("parts_table_hint"), false);
    assert.deepEqual(
      sourceRow?.cells.flatMap((cell) => cell.references.map((reference) => reference.referenceId)),
      ["fd_parts_table"]
    );
    assert.equal(mkRow?.componentId, "xform-flex-1-1-layout");
    assert.deepEqual(mkRow?.props, { columns: 1, sourceColumns: 1 });
    assert.deepEqual(mkRow?.children.map((cell) => cell.refIds), [["fd_parts_table"]]);
    assert.deepEqual(
      mkRow?.children.map((cell) => ({ refType: cell.refType, row: cell.row, column: cell.column, colspan: cell.colspan })),
      [{ refType: "detailTable", row: undefined, column: 0, colspan: 1 }]
    );
  });

  it("does not merge a detail note across a supported control or when ownership is ambiguous", () => {
    const dsl = draftSourceDraft(cleanSourceFile(inlineContentFixture));
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));

    assert.equal(fields.get("fd_guarded_parts_table")?.title, "DetailTable13");
    assert.equal(fields.get("guarded_parts_hint")?.props.content, "Must remain standalone");
    assert.equal(fields.get("fd_ambiguous_parts")?.title, "Ambiguous parts");
    assert.equal(fields.get("ambiguous_parts_hint_a")?.props.content, "First styled note");
    assert.equal(fields.get("ambiguous_parts_hint_b")?.props.content, "Second styled note");
  });

  it("does not merge a styled note when an existing business title conflicts with the visible heading", () => {
    const heading = {
      id: "visible_heading",
      title: "Visible heading",
      type: "description",
      source: { designerType: "textLabel", designerValues: { size: "18px", b: "true" } }
    };
    const hint = {
      id: "styled_hint",
      title: "Must stay standalone",
      type: "description",
      source: { designerType: "textLabel", designerValues: { color: "#FF0000" } }
    };
    const detail = {
      id: "fd_named_detail",
      title: "Canonical business title",
      type: "detailTable",
      source: { designerType: "detailsTable", designerValues: {} }
    };

    const result = applyAdjacentDetailTableTitles(
      [heading, hint, detail],
      () => false,
      { hasDirectBreakBetween: () => true }
    );

    assert.deepEqual(result, [heading, hint, detail]);
  });

  it("merges only a pre-detail owned note and keeps a post-detail note standalone", () => {
    const dsl = draftSourceDraft(cleanSourceFile(inlineContentFixture));
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const sourceRow = dsl.form.layout.sourceGrid.rows.find((row) =>
      row.sourceMarkers?.includes("post_detail_row")
    );
    const targetRows = dsl.form.layout.mkTree.filter((row) =>
      row.sourceRef === sourceRow?.sourceRef
    );
    const detailRow = targetRows.find((row) =>
      row.children.some((child) => child.refIds.includes("fd_post_hint_table"))
    );

    assert.equal(fields.get("fd_post_hint_table")?.title, "Gift allocation(Namedguidance)");
    assert.deepEqual(fields.get("fd_post_hint_table")?.sourceProps.detailTitleHint, {
      id: "named_detail_hint",
      content: "Named guidance",
      rawContent: " Named guidance ",
      designerValues: {
        id: "named_detail_hint",
        content: " Named guidance ",
        color: "#FF0000",
        b: "false"
      },
      relation: "post-heading-break-styled-text-before-detail-table"
    });
    assert.equal(fields.has("named_detail_heading"), false);
    assert.equal(fields.has("named_detail_hint"), false);
    assert.equal(fields.get("post_detail_hint")?.props.content, " Post-detail guidance ");
    assert.deepEqual(
      sourceRow?.cells.flatMap((cell) => cell.references.map((reference) => reference.referenceId)),
      ["fd_before_post_detail", "fd_post_hint_table", "post_detail_hint", "fd_after_post_detail"]
    );
    assert.equal(sourceRow?.cells.length, 3);
    assert.deepEqual(
      sourceRow?.cells[1].references.map((reference) => reference.referenceId),
      ["fd_post_hint_table", "post_detail_hint"]
    );
    assert.deepEqual(
      targetRows.map((row) => row.children.flatMap((child) => child.refIds)),
      [["fd_before_post_detail"], ["fd_post_hint_table"], ["post_detail_hint", "fd_after_post_detail"]]
    );
    assert.deepEqual(detailRow?.sourceMarkers, ["post_detail_row"]);
    assert.equal(targetRows.filter((row) => row.sourceMarkers?.includes("post_detail_row")).length, 1);
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

  it("preserves a five-control source row as one five-column layout and keeps its marker target", () => {
    const source = cleanSourceFile(inlineContentFixture);
    const dsl = draftSourceDraft(source);
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
    const sourceRow = dsl.form.layout.sourceGrid.rows.find((candidate) =>
      candidate.sourceMarkers?.includes("fd_overflow_row")
    );
    const markerTarget = resolveEffectTarget(buildFormRuleRefIndex(dsl.form), "fd_overflow_row");

    assert.equal(sourceRow?.cells.length, 3);
    assert.deepEqual(
      sourceRow?.cells.map((cell) => cell.references.map((reference) => reference.referenceId)),
      [["fd_slot_alpha"], ["fd_slot_bravo"], ["fd_slot_charlie", "fd_slot_delta", "fd_slot_echo"]]
    );
    assert.equal(rows.length, 1);
    assert.equal(row.componentId, "xform-multi-row-table-layout");
    assert.deepEqual(row.props, { rows: 1, columns: 5 });
    assert.equal(row.children.length, 5);
    assert.deepEqual(row.children.flatMap((cell) => cell.refIds), ids);
    assert.deepEqual(row.children.map((cell) => cell.row), [0, 0, 0, 0, 0]);
    assert.deepEqual(row.children.map((cell) => cell.column), [0, 1, 2, 3, 4]);
    assert.deepEqual(markerTarget?.targets.map((target) => target.id), ids);
    assert.equal(row.children.every((cell) => cell.row === 0 && cell.column < 5), true);
  });

  it("removes an exact same-title trailing plain label before choosing the target column count", () => {
    const dsl = draftSourceDraft(cleanSourceFile(inlineContentFixture));
    const ids = [
      "fd_address_country",
      "fd_address_province",
      "fd_address_city",
      "fd_address_district"
    ];
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const sourceRow = dsl.form.layout.sourceGrid.rows.find((row) =>
      row.cells.some((cell) =>
        cell.references.some((reference) => reference.referenceId === "fd_address_country")
      )
    );
    const mkRow = dsl.form.layout.mkTree.find((row) =>
      row.children.some((cell) => cell.refIds.includes("fd_address_country"))
    );

    assert.equal(fields.has("address_district_duplicate_label"), false);
    assert.deepEqual(fields.get("fd_address_district")?.sourceProps.inlineCaption, {
      id: "address_district_duplicate_label",
      content: "Address district",
      relation: "trailing-duplicate-caption"
    });
    assert.deepEqual(
      sourceRow?.cells.flatMap((cell) => cell.references.map((reference) => reference.referenceId)),
      ids
    );
    assert.equal(mkRow?.componentId, "xform-flex-1-4-layout");
    assert.deepEqual(mkRow?.props, { columns: 4, sourceColumns: 4 });
    assert.deepEqual(mkRow?.children.map((cell) => cell.refIds), ids.map((id) => [id]));
    assert.deepEqual(mkRow?.children.map((cell) => cell.column), [0, 1, 2, 3]);
  });

  it("keeps same-title trailing labels when a break or visible styling makes them meaningful", () => {
    const source = cleanSourceFile(inlineContentFixture);
    const dsl = draftSourceDraft(source);
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const sourceControls = new Map(source.form.controls.map((field) => [field.id, field]));
    const afterBreakRow = source.form.layout.rows.find((row) =>
      row.cells.some((cell) =>
        cell.references.some((reference) => reference.referenceId === "fd_same_title_after_break")
      )
    );

    assert.equal(fields.get("fd_same_title_after_break")?.sourceProps.inlineCaption, undefined);
    assert.equal(sourceControls.get("after_break_label")?.title, "Separate after break");
    assert.deepEqual(
      afterBreakRow?.cells[0].references.map((reference) => reference.referenceId),
      ["fd_same_title_after_break", "after_break_label"]
    );
    assert.equal(fields.get("fd_same_title_styled")?.sourceProps.inlineCaption, undefined);
    assert.equal(fields.get("styled_same_title_label")?.props.content, "Styled same title");
    assert.deepEqual(fields.get("styled_same_title_label")?.props.style, {
      color: "rgba(204,51,0,1)"
    });
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

  it("uses unambiguous bound captions while preserving unbound real descriptions", () => {
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

    assert.equal(fields.has("different_bound_caption"), false);
    assert.equal(fields.get("fd_machine_named_value")?.componentId, "xform-input");
    assert.equal(fields.get("fd_machine_named_value")?.title, "Human-readable caption");
    assert.deepEqual(
      rowRefs.find((references) => references.includes("fd_machine_named_value")),
      ["fd_machine_named_value"]
    );

    assert.equal(fields.has("detail_companion_caption"), false);
    assert.equal(fields.get("fd_detail_companion_total")?.componentId, "xform-input");
    assert.equal(fields.get("fd_detail_companion_total")?.title, "Readable total");
    assert.deepEqual(
      rowRefs.find((references) => references.includes("fd_detail_companion_total")),
      ["fd_detail_with_caption", "fd_detail_companion_total"]
    );
  });

  it("keeps source-grid evidence intact while giving every detail table its own target row", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const detailIds = new Set(
      dsl.form.fields.filter((field) => field.type === "detailTable").map((field) => field.id)
    );
    const sourceRow = dsl.form.layout.sourceGrid.rows.find((row) =>
      row.cells.some((cell) =>
        cell.references.some((reference) => reference.referenceId === "fd_detail_with_caption")
      )
    );
    const targetRows = dsl.form.layout.mkTree;
    const detailRowIndex = targetRows.findIndex((row) =>
      row.children.some((cell) => cell.refIds.includes("fd_detail_with_caption"))
    );
    const companionRowIndex = targetRows.findIndex((row) =>
      row.children.some((cell) => cell.refIds.includes("fd_detail_companion_total"))
    );
    const guardedSourceRow = dsl.form.layout.sourceGrid.rows.find((row) =>
      row.cells.some((cell) =>
        cell.references.some((reference) => reference.referenceId === "fd_between_heading_table")
      )
    );
    const guardedOrdinaryRowIndex = targetRows.findIndex((row) =>
      row.children.some((cell) => cell.refIds.includes("fd_between_heading_table"))
    );
    const guardedDetailRowIndex = targetRows.findIndex((row) =>
      row.children.some((cell) => cell.refIds.includes("fd_detail_gap"))
    );
    const twinAIndex = targetRows.findIndex((row) =>
      row.children.some((cell) => cell.refIds.includes("fd_detail_twin_a"))
    );
    const twinBIndex = targetRows.findIndex((row) =>
      row.children.some((cell) => cell.refIds.includes("fd_detail_twin_b"))
    );

    assert.deepEqual(
      sourceRow?.cells.flatMap((cell) => cell.references.map((reference) => reference.referenceId)),
      ["fd_detail_with_caption", "fd_detail_companion_total"]
    );
    assert.deepEqual(
      dsl.form.fields.find((field) => field.id === "fd_detail_companion_total")?.sourceProps.boundCaption,
      {
        id: "detail_companion_caption",
        content: "Readable total",
        relation: "explicit-label-bind-id"
      }
    );
    assert.equal(sourceRow?.cells.length, 1);
    assert.equal(detailRowIndex >= 0, true);
    assert.equal(companionRowIndex > detailRowIndex, true);
    assert.deepEqual(
      guardedSourceRow?.cells.flatMap((cell) => cell.references.map((reference) => reference.referenceId)),
      ["heading_not_adjacent", "fd_between_heading_table", "fd_detail_gap"]
    );
    assert.equal(guardedSourceRow?.cells.length, 1);
    assert.equal(guardedOrdinaryRowIndex < guardedDetailRowIndex, true);
    assert.equal(twinBIndex, twinAIndex + 1);
    for (const detailId of detailIds) {
      const owningRows = targetRows.filter((row) =>
        row.children.some((child) => child.refIds.includes(detailId))
      );
      assert.equal(owningRows.length, 1, detailId);
      assert.equal(owningRows[0].componentId, "xform-flex-1-1-layout", detailId);
      assert.equal(owningRows[0].props.columns, 1, detailId);
      assert.equal(owningRows[0].children.length, 1, detailId);
      assert.deepEqual(owningRows[0].children[0].refIds, [detailId], detailId);
      assert.equal(owningRows[0].children[0].refType, "detailTable", detailId);
      assert.equal(owningRows[0].children[0].column, 0, detailId);
      assert.equal(owningRows[0].children[0].colspan, 1, detailId);
    }
  });
});
