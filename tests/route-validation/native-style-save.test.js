import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeViewSaveRoundTrip, verifyNativeSaveSources } from "../helpers/native-view-save.js";

const source = "tests/fixtures/route-validation/adaptive-layout/adaptive-layout_SysFormTemplate.xml";
const nodes = node => [node, ...(node.children || []).flatMap(nodes)];
const css = node => node.controlProps?.source?.css ||
  node.controlProps?.dangerouslySetInnerHTML?.__html?.match(/^<style>([\s\S]*)<\/style>$/)?.[1];

it("pins native designer serialization and reassembly sources", verifyNativeSaveSources);

for (const [fixture, sizing, count] of [
  [source, "adaptive", 1]
]) it(`retains scoped styles and business fields across native saves: ${fixture}, ${sizing}`, () => {
  const dsl = draftSourceDraft(cleanSourceFile(fixture), { layoutSizing: sizing });
  const prepared = prepareSample(dsl), original = xformConfig(prepared.update);
  const after = nativeViewSaveRoundTrip(original);
  const beforeView = JSON.parse(original.viewModel[0].fdConfig), savedView = JSON.parse(after.viewModel[0].fdConfig);
  assert.deepEqual(after.dataModel, original.dataModel, "Presentation must not add or change business model fields");
  for (const scene of ["desktop", "mobile"]) {
    const initial = nodes(beforeView.view.render[scene][0]).filter(css).map(css);
    const saved = nodes(savedView.view.render[scene][0]).filter(css).map(css);
    assert.equal(initial.length, count);
    assert.deepEqual(saved, initial, `${scene}: native save must retain the actual stylesheet`);
  }
  const target = structuredClone(prepared.update);
  target.mechanisms["sys-xform"].fdConfig = JSON.stringify(after);
  assert.equal(prepared.verify(target).ok, true, "Readback must inspect the post-save structure");
});

for (const scene of ["desktop", "mobile"]) it(`reports malformed ${scene} native containers without throwing`, () => {
  const prepared = prepareSample(draftSourceDraft(cleanSourceFile(source)));
  const target = structuredClone(prepared.update), config = xformConfig(target);
  const view = JSON.parse(config.viewModel[0].fdConfig);
  view.view.render[scene][0].children.push({ type: "div", kind: "container" });
  config.viewModel[0].fdConfig = JSON.stringify(view);
  target.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  assert.equal(prepared.verify(target).ok, false);
});
