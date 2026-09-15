import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

import { renderNativeFieldReferences } from "../helpers/native-form-renderer.js";
const flow = {
  lines: [["fd_subject", "fd_amount"], [], ["fd_note"]],
  items: [
    { referenceId: "fd_subject", width: { value: 120, unit: "px" } },
    { referenceId: "fd_amount", width: { value: 45, unit: "%" } },
    { referenceId: "fd_note" }
  ]
};

describe("native cell content flow", () => {
  it("keeps explicit lines, empty lines, wrapping, and physical item widths through readback", () => {
    const prepared = prepareSample(flowDsl());
    const result = prepared.verify(prepared.update);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.form.layoutRows[0].cells[0].contentFlow, flow);
    const root = nativeFlow(prepared.update);
    assert.equal(root.children.length, 3);
    assert.equal(root.children[1].controlProps.style.minHeight, "1.5em");
    assert.equal(root.children[0].controlProps.style.flexWrap, "wrap");
    assert.equal(root.children[0].children[0].controlProps.style.width, "120px");
    assert.equal(root.children[0].children[1].controlProps.style.width, "45%");
    assert.equal(root.children[2].children[0].controlProps.style.width, undefined);
    assert.equal(root.children[2].children[0].controlProps.style.flex, "0 1 auto");
    assert.equal(JSON.stringify(root).includes("spans"), false);
  });

  it("preserves content flow when flattening a nested layout", () => {
    const dsl = flowDsl();
    const inner = dsl.form.layout.mkTree[0];
    dsl.form.layout.mkTree.unshift({
      id: "layout.outer", componentId: "xform-flex-1-1-layout", props: { columns: 1 },
      children: [{ id: "outer.cell", refType: "layout", refIds: [inner.id], column: 0, colspan: 1 }]
    });
    const projection = projectNativeLayoutRows(dsl.form.layout.mkTree);
    assert.deepEqual(projection[0].cells[0].contentFlow, flow);
    const prepared = prepareSample(dsl);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });

  it("preserves an explicitly zero source width", () => {
    const dsl = flowDsl();
    const expected = dsl.form.layout.mkTree[0].children[0].contentFlow;
    expected.items[0].width.value = 0;
    const prepared = prepareSample(dsl);
    assert.equal(nativeFlow(prepared.update).children[0].children[0].controlProps.style.width, "0px");
    const result = prepared.verify(prepared.update);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.form.layoutRows[0].cells[0].contentFlow, expected);
  });

  it("observes line and width evidence independently of migration markers", () => {
    const prepared = prepareSample(flowDsl());
    const changed = structuredClone(prepared.update);
    const clearMarkers = (node) => {
      for (const key of Object.keys(node)) {
        if (key.startsWith("migration")) delete node[key];
        else if (node[key] && typeof node[key] === "object") clearMarkers(node[key]);
      }
    };
    for (const scene of ["desktop", "mobile"]) mutateNativeFlow(changed, clearMarkers, scene);
    const result = prepared.verify(changed);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.form.layoutRows[0].cells[0].contentFlow, flow);
  });

  for (const scenario of [
    { name: "forced nowrap", mutate: (root) => { root.children[0].controlProps.style.flexWrap = "nowrap"; } },
    { name: "unregistered flex container", mutate: (root) => { root.type = "@elem/flex"; } },
    { name: "missing flex display", mutate: (root) => { delete root.children[0].controlProps.style.display; } },
    { name: "hidden container", mutate: (root) => { root.controlProps.hidden = true; } },
    { name: "native CSS class changing a line direction", mutate: (root) => { root.children[0].controlProps.className = "ele-flex-flexDirCol"; } },
    { name: "native item gutter changing physical placement", mutate: (root) => { root.children[0].children[0].controlProps.colGutter = 300; } },
    { name: "missing line", mutate: (root) => { root.children.splice(1, 1); } },
    { name: "collapsed empty line", mutate: (root) => { delete root.children[1].controlProps.style.minHeight; } },
    { name: "changed physical width", mutate: (root) => { root.children[0].children[0].controlProps.style.width = "12px"; } },
    { name: "fixed control shrinking", mutate: (root) => { root.children[0].children[0].controlProps.style.flex = "0 1 auto"; } },
    { name: "reordered actual references", mutate: (root) => { root.children[0].children.reverse(); } },
    { name: "unsupported native item", mutate: (root) => { root.children[0].children[0].type = "@elem/unknown-flow-item"; } }
  ]) {
    it(`rejects ${scenario.name} even when migration markers are unchanged`, () => {
      const prepared = prepareSample(flowDsl());
      const changed = structuredClone(prepared.update);
      mutateNativeFlow(changed, scenario.mutate);
      const result = prepared.verify(changed);
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some((item) => item.code.includes("content_flow") || item.code.includes("layout_cell_fields")), JSON.stringify(result.diagnostics));
    });
  }

  it("rejects a mobile-only flow regression", () => {
    const prepared = prepareSample(flowDsl());
    const changed = structuredClone(prepared.update);
    mutateNativeFlow(changed, (root) => { root.children[0].controlProps.style.flexWrap = "nowrap"; }, "mobile");
    assert.equal(prepared.verify(changed).ok, false);
  });

  it("allows opaque platform metadata that the native renderer does not consume", () => {
    const prepared = prepareSample(flowDsl());
    const changed = structuredClone(prepared.update);
    mutateNativeFlow(changed, (root) => {
      root.controlProps.platformRevision = "readback-123";
      root.children[0].children[0].controlProps.platformRevision = "readback-124";
    });
    assert.equal(prepared.verify(changed).ok, true);
  });

  it("renders flow fields through the native built-in container registration", () => {
    const prepared = prepareSample(flowDsl());
    const rendered = renderNativeFieldReferences(xformConfig(prepared.update));
    assert.deepEqual(rendered.actual, rendered.expected);
    assert.equal(rendered.actual.length, 3);
    const nodes = [];
    const visit = (node) => {
      if (!node) return;
      if (Array.isArray(node)) return node.forEach(visit);
      nodes.push(node);
      node.children?.forEach(visit);
    };
    visit(rendered.output);
    const fixedItem = nodes.find(node => node.props?.style?.width === "120px");
    assert.equal(fixedItem.type, "div");
    assert.equal(fixedItem.props.style.flex, "0 0 auto");
    assert.ok(nodes.some(node => node.type === "div" && node.props?.style?.display === "flex" && node.props.style.flexWrap === "wrap"));
  });
});

function flowDsl() {
  const dsl = sampleTrustedDsl({ workflow: null });
  dsl.form.fields = dsl.form.fields.filter((field) => field.id !== "fd_detail");
  dsl.form.fields.push({ id: "fd_note", title: "备注", type: "description", componentId: "xform-description", props: { content: "说明文字" } });
  dsl.form.layout.mkTree = [{
    id: "layout.flow", componentId: "xform-flex-1-1-layout", props: { columns: 1 },
    children: [{ id: "flow.cell", refType: "field", refIds: flow.lines.flat(), column: 0, colspan: 1, keepInline: true, contentFlow: structuredClone(flow) }]
  }];
  return dsl;
}

function nativeFlow(template, scene = "desktop") {
  const config = xformConfig(template);
  const view = JSON.parse(config.viewModel[0].fdConfig);
  return view.view.render[scene][0].children[0].children[0].children[0].children[0].children[0];
}

function mutateNativeFlow(template, mutate, scene = "desktop") {
  const config = xformConfig(template);
  const view = JSON.parse(config.viewModel[0].fdConfig);
  mutate(view.view.render[scene][0].children[0].children[0].children[0].children[0].children[0]);
  config.viewModel[0].fdConfig = JSON.stringify(view);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
}
