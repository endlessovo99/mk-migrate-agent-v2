import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeViewSaveRoundTrip } from "../helpers/native-view-save.js";

const fixture = "tests/fixtures/route-validation/source-shared-track-layout/source-local-centered-heading_SysFormTemplate.xml";
const nodes = node => [node, ...(node.children || []).flatMap(nodes)];
const render = prepared => JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig).view.render;
const wrapper = (root, id) => nodes(root).find(node => node.controlProps?.className === "mk-adaptive-main-field" && node.children?.some(child => child.key === id));
const stages = () => { const source = cleanSourceFile(fixture), draft = draftSourceDraft(source); return { source, draft }; };

it("centers a proved full source cell across its native wrapper without shared-root evidence", () => {
  const { source, draft } = stages(), prepared = prepareSample(draft), view = render(prepared);
  assert.equal(source.form.layout.rootTable, undefined, "Two source tables do not prove one shared column lattice");
  const original = source.form.layout.rows.find(row => row.id === "row-0");
  assert.equal(original.cells[0].colspan, 4);
  assert.equal(original.cells[0].widthWeight, 2024);
  for (const scene of ["desktop", "mobile"]) {
    const item = wrapper(view[scene][0], "local_heading");
    assert.equal(item.controlProps.style.flex, "1 1 0", "text-align:center needs the complete source cell, not an intrinsic-width text box");
    for (const id of ["inline_caption", "cell_caption"]) assert.equal(wrapper(view[scene][0], id).controlProps.style.flex, "0 1 auto");
    assert.ok(nodes(view[scene][0]).filter(node => node.type === "@elem/layout-grid")
      .every(node => node.controlProps.colsStyle.every(style => style.value === "auto")), "Local title evidence does not promote any shared tracks");
  }
  const field = draft.form.fields.find(field => field.id === "local_heading");
  assert.deepEqual(field.props.style, { fontSize: 16, textAlign: "center", fontWeight: "bold" });
  assert.equal(draft.form.fields.find(field => field.id === "fd_amount").props.unit, "元");
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("leaves incomplete or mismatching local heading evidence intrinsic", () => {
  for (const change of [
    draft => { draft.form.layout.sourceGrid.source = "unproved"; },
    draft => { delete draft.form.layout.sourceGrid.rows[0].cells[0].evidence; },
    draft => { draft.form.layout.sourceGrid.rows[0].cells[0].evidence.widthWeight++; },
    draft => { draft.form.layout.mkTree[0].children[0].widthWeight++; },
    draft => { draft.form.layout.mkTree[0].children[0].sourceRef = "source.form.layout.cell.unknown"; },
    draft => { draft.form.layout.mkTree[0].props.sourceColumns++; },
    draft => { delete draft.form.fields.find(field => field.id === "local_heading").sourceProps.textPresentation.textAlign; },
    draft => { draft.form.fields.find(field => field.id === "local_heading").sourceProps.designerValues.content = "Different heading"; },
    draft => { draft.form.layout.sourceGrid.rows[0].cells[0].references[0].sourceRef = "source.form.control.unknown"; },
    draft => { draft.form.layout.sourceGrid.rows[0].cells[0].contentFlow.items[0].width = { value: 200, unit: "px" }; draft.form.layout.mkTree[0].children[0].contentFlow.items[0].width = { value: 200, unit: "px" }; }
  ]) {
    const { draft } = stages(); change(draft);
    assert.equal(wrapper(render(prepareSample(draft)).desktop[0], "local_heading").controlProps.style.flex, "0 1 auto");
  }
});

it("retains the centered cell through native save and detects losing its width", () => {
  const { draft } = stages(), prepared = prepareSample(draft), before = xformConfig(prepared.update), saved = nativeViewSaveRoundTrip(before);
  for (const key of ["dataModel", "attribute", "auth", "authFilter"]) assert.deepEqual(saved[key], before[key]);
  const target = structuredClone(prepared.update); target.mechanisms["sys-xform"].fdConfig = JSON.stringify(saved);
  assert.equal(prepared.verify(target).ok, true);
  const view = JSON.parse(saved.viewModel[0].fdConfig);
  wrapper(view.view.render.desktop[0], "local_heading").controlProps.style.flex = "0 1 auto";
  saved.viewModel[0].fdConfig = JSON.stringify(view); target.mechanisms["sys-xform"].fdConfig = JSON.stringify(saved);
  assert.equal(prepared.verify(target).ok, false);
});
