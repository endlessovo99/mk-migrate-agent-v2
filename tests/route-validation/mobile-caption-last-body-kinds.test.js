import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sourceMobileCaptionGrids } from "../../src/dsl/source-mobile-caption-grid.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const path = "tests/fixtures/route-validation/mobile-caption-last-body/canonical-body-kinds_SysFormTemplate.xml";
const load = () => { const source = cleanSourceFile(path); return { source, dsl: draftSourceDraft(source) }; };
const field = (dsl, id) => dsl.form.fields.find(item => item.id === id);
const grids = (view, scene) => view.view.render[scene][0].children[0].children.map(row => row.children.find(node => node.type === "@elem/layout-grid"));
const trust = (source, dsl) => checkTrust(source, createTrustedMigrationDsl(source, dsl, {
  externalAgentReviewed: true, reviewerName: "synthetic unreviewed canonical last-body source-bound test"
}));

it("retains real parser rtf, widthless select and attachment identities and source widget semantics", () => {
  const { source, dsl } = load();
  assert.equal(source.form.layout.rows.length, 3);
  assert.equal(dsl.scripts?.actions?.length || 0, 0);
  for (const [index, kind, id, type, componentId] of [
    [0, "rich", "fd_rich", "longText", "xform-rich-text"],
    [1, "select", "fd_select", "singleSelect", "xform-select"],
    [2, "files", "fd_files", "attachment", "xform-attach"]
  ]) {
    const body = field(dsl, id), caption = field(dsl, `caption_${kind}`), row = dsl.form.layout.mkTree[index];
    assert.equal(body.id, id); assert.equal(body.type, type); assert.equal(body.componentId, componentId);
    assert.equal(body.sourceProps.designerId, id);
    assert.equal(body.sourceProps.designerValues.id, id);
    assert.equal(caption.sourceProps.runtimePlainCaption, true);
    assert.deepEqual(row.children.map(cell => [cell.column, cell.colspan, cell.refIds]), [[0, 1, [caption.id]], [1, 3, [id]]]);
    assert.equal(body.props.style, undefined);
    assert.equal(body.dataOnly, undefined);
    assert.equal(body.props.required === true, false);
    if (kind === "rich") {
      assert.equal(body.sourceProps.designerValues.width, "80%");
      assert.equal(body.sourceProps.designerValues.height, "220");
      assert.deepEqual(row.children[1].contentFlow.items[0].width, { value: 80, unit: "%" });
      assert.equal(body.props.maxLength, 1000000);
    } else {
      assert.equal(Object.hasOwn(body.sourceProps.designerValues, "width"), false);
      assert.equal(row.children[1].contentFlow.items[0].width, undefined);
    }
  }
  assert.deepEqual(field(dsl, "fd_select").props.options, [{ label: "First", value: "A" }, { label: "Second", value: "B" }]);
  assert.deepEqual(field(dsl, "fd_select").props.defaultValue, { kind: "literal", value: "B" });
  const prepared = prepareSample(dsl), checked = prepared.verify(prepared.update);
  assert.equal(checked.ok, true, "Existing native request must already be valid before asking for the new profile");
  assert.equal(checked.invariantVersion, 39);
  assert.equal(trust(source, dsl).ok, true);
});

it("changes only each proven caption track while retaining all body tracks, PC widgets and fixed source binding", () => {
  const { source, dsl } = load(), before = structuredClone(dsl), profiles = sourceMobileCaptionGrids(dsl.form);
  assert.equal(profiles.size, 3, "Each actual main body kind must qualify without inventing a fixed width");
  const prepared = prepareSample(dsl), config = xformConfig(prepared.update), view = JSON.parse(config.viewModel[0].fdConfig);
  const pc = grids(view, "desktop"), mobile = grids(view, "mobile");
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(mobile[index].controlProps.colsStyle, pc[index].controlProps.colsStyle.map((style, column) => column === 0
      ? { ...style, value: `minmax(max-content, ${Number.parseFloat(style.value)}fr)` } : style));
    assert.deepEqual(mobile[index].controlProps.colsStyle.slice(1), pc[index].controlProps.colsStyle.slice(1));
    assert.deepEqual(mobile[index].controlProps.style, { overflowX: "auto" });
    assert.deepEqual(mobile[index].children, pc[index].children, "The existing native rich text/select/attach config and source cell geometry remain exact");
    assert.equal(mobile[index].controlProps.columns, pc[index].controlProps.columns);
    assert.equal(mobile[index].controlProps.rows, pc[index].controlProps.rows);
  }
  assert.deepEqual(dsl, before);
  assert.equal(prepared.verify(prepared.update).ok, true);
  assert.equal(prepared.verify(prepared.update).invariantVersion, 39);
  for (const mutate of [
    candidate => { field(candidate, "fd_rich").sourceProps.designerValues.width = "90%"; },
    candidate => { field(candidate, "fd_select").props.options[0].value = "changed"; },
    candidate => { field(candidate, "fd_files").dataOnly = true; }
  ]) {
    const candidate = structuredClone(dsl); mutate(candidate); assert.notDeepEqual(candidate, dsl);
    const checked = trust(source, candidate);
    assert.equal(checked.ok, false);
    assert.ok(checked.diagnostics.some(item => /mobile_plain_caption_source_mismatch/.test(item.code)), JSON.stringify(checked.diagnostics));
    const applied = applyEvidenceBackedPatches(candidate, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    assert.equal(applied.ok, false);
    assert.ok(applied.diagnostics.some(item => /mobile_plain_caption_source_mismatch/.test(item.code)), JSON.stringify(applied.diagnostics));
  }
});
