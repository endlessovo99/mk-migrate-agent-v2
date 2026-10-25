import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { completeRootAxis } from "../../src/executor/persistence/complete-root-axis.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeViewSaveRoundTrip, verifyNativeSaveSources } from "../helpers/native-view-save.js";

const fixtures = new URL("../fixtures/executor/persistence/complete-root-axis/", import.meta.url);
const read = name => readFileSync(new URL(name, fixtures), "utf8");
const provenance = JSON.parse(read("provenance.json"));
const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const digest = value => hash(canonical(value));
const baselineBytes = read(provenance.baseline.file);
assert.equal(hash(baselineBytes), provenance.baseline.sha256);
const baseline = JSON.parse(baselineBytes);
assert.equal(baseline.baselineHead, provenance.baselineHead);

// The baseline contains frozen F22 data, not an implementation imported under a
// second name. Every projection below calls the installed product implementation.
function stage(name = "base") {
  const fixture = provenance.fixtures[name];
  assert.equal(hash(read(fixture.file)), fixture.sha256, fixture.file);
  const draft = draftSourceDraft(cleanSourceFile(fileURLToPath(new URL(fixture.file, fixtures))));
  draft.form.layout.sizing = "adaptive";
  return draft;
}
function project(draft, mobile = false) {
  return projectNativeLayoutRows(draft.form.layout.mkTree, { ...draft.form.layout, fields: draft.form.fields, mobile });
}
const row = (rows, index) => rows.find(entry => entry.id === "layout.row-" + index);
function plan(draft, caseName) {
  return completeRootAxis(structuredClone(baseline.cases[caseName].desktop), draft.form.layout.mkTree,
    draft.form.layout.sourceGrid, draft.form.fields);
}
function assertBaselineGeometry(draft, caseName) {
  assert.deepEqual(project(draft), baseline.cases[caseName].desktop);
}
function assertProtectedNative(config, fixtureName) {
  const expected = baseline.native[fixtureName];
  const partitions = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "viewModel")
    .map(([key, value]) => [key, digest(value)]));
  assert.deepEqual(partitions, expected.protectedPartitions, "all non-view native partitions remain unchanged");
  const view = JSON.parse(config.viewModel[0].fdConfig);
  assert.equal(digest(view.view.render.mobile), expected.mobileRender, "native mobile render remains unchanged");
  assert.equal(digest(view.controlStyle), expected.controlStyle);
  assert.equal(digest(view.theme), expected.theme);
  return view;
}

for (const name of ["base", "renamed"]) {
  it(name + ": maps the complete physical root, including mixed lines, empty tail, rowspan and folded captions", () => {
    const draft = stage(name), original = structuredClone(draft), actual = project(draft);
    assert.equal(draft.form.layout.sourceGrid.rootTable.rowCount, 6);
    assert.equal(actual.length, 5);
    assert.ok(baseline.cases[name].desktop.some(entry => entry.columns !== 4));
    assert.ok(actual.every(entry => entry.columns === 4));
    assert.deepEqual(row(actual, 1).cells.at(-1).contentFlow, row(baseline.cases[name].desktop, 1).cells.at(-1).contentFlow);
    assert.equal(row(actual, 1).cells.at(-1).contentFlow.lines.length, 2);
    assert.equal(row(actual, 2).cells.at(-1).column + row(actual, 2).cells.at(-1).colspan, 2,
      "two empty source columns remain empty");
    assert.equal(row(actual, 3).rows, 2);
    assert.equal(row(actual, 3).cells[0].rowspan, 2);
    assert.deepEqual(row(actual, 5).cells.map(cell => [cell.column, cell.colspan, cell.captionWidth]),
      [[0, 2, "50%"], [2, 2, "50%"]]);
    for (const entry of actual) assert.deepEqual(entry.colsStyle, [{ startIndex: 0, count: 4, value: "minmax(0, 1fr)" }]);
    assert.deepEqual(draft, original, "projection does not mutate the DSL");
    assert.deepEqual(project(draft, true), baseline.cases[name].mobile);
  });
}

it("a bad later member rejects the whole root, including earlier mixed rows", () => {
  const draft = stage();
  draft.form.layout.sourceGrid.rows.find(entry => entry.sourceRow === "5").cells[3].references[0].referenceId = "not_the_field";
  assert.equal(plan(draft, "bad-member").admitted, false);
  assertBaselineGeometry(draft, "bad-member");
});

it("a nested region without source rowspan proof cannot share the physical root axis", () => {
  const draft = stage();
  for (const cell of draft.form.layout.sourceGrid.rows.find(entry => entry.sourceRow === "3").cells) {
    delete cell.rowspan;
    if (cell.evidence) delete cell.evidence.rowspan;
  }
  const result = plan(draft, "no-rowspan-proof");
  assert.equal(result.admitted, false);
  assert.match(result.detail, /independent-nested-table-or-unproved-rowspan/);
  assertBaselineGeometry(draft, "no-rowspan-proof");
});

it("missing physical row, missing root proof, overlap and nonadaptive layout preserve F22 geometry", () => {
  const mutations = {
    "missing-physical-row": draft => { draft.form.layout.sourceGrid.rows.splice(0, 1); },
    "missing-root-proof": draft => { delete draft.form.layout.sourceGrid.rootTable; },
    overlap: draft => {
      const cell = draft.form.layout.sourceGrid.rows[1].cells[1];
      cell.column = 0;
      cell.evidence.column = 0;
    },
    "source-sizing": draft => { draft.form.layout.sizing = "source"; }
  };
  for (const [caseName, mutate] of Object.entries(mutations)) {
    const draft = stage();
    mutate(draft);
    assertBaselineGeometry(draft, caseName);
  }
});

it("merged rows alone do not activate the policy when complete preferences agree", () => {
  const draft = stage(), rows = draft.form.layout.sourceGrid.rows;
  const first = rows.find(entry => entry.sourceRow === "0").cells;
  rows.find(entry => entry.sourceRow === "5").cells.forEach((cell, index) => {
    cell.widthWeight = first[index].widthWeight;
    cell.evidence.widthWeight = cell.widthWeight;
  });
  assert.equal(plan(draft, "compatible-preferences").reason, "no-conflicting-complete-preferences");
  assertBaselineGeometry(draft, "compatible-preferences");
});

it("width preferences that disagree with source evidence cannot activate root reflow", () => {
  const draft = stage(), rows = draft.form.layout.sourceGrid.rows;
  const first = rows.find(entry => entry.sourceRow === "0").cells;
  const last = rows.find(entry => entry.sourceRow === "5").cells;
  last.forEach((cell, index) => {
    cell.widthWeight = first[index].widthWeight;
    cell.evidence.widthWeight = cell.widthWeight;
  });
  last[3].widthWeight += 80;
  const result = plan(draft, "compatible-preferences");
  assert.equal(result.admitted, false);
  assert.deepEqual(result.projected, baseline.cases["compatible-preferences"].desktop);
  assertBaselineGeometry(draft, "compatible-preferences");
});

it("native persistence/save retains protected data and mobile geometry and rejects desktop geometry copied to mobile", () => {
  const prepared = prepareSample(stage());
  assert.equal(prepared.verify(prepared.update).ok, true);
  const config = xformConfig(prepared.update), view = assertProtectedNative(config, "base");
  verifyNativeSaveSources();
  const round = nativeViewSaveRoundTrip(config);
  const saved = structuredClone(prepared.update);
  saved.mechanisms["sys-xform"].fdConfig = JSON.stringify(round);
  assert.equal(prepared.verify(saved).ok, true);

  const corrupted = structuredClone(prepared.update), bad = xformConfig(corrupted);
  const badView = JSON.parse(bad.viewModel[0].fdConfig);
  badView.view.render.mobile = structuredClone(view.view.render.desktop);
  bad.viewModel[0].fdConfig = JSON.stringify(badView);
  corrupted.mechanisms["sys-xform"].fdConfig = JSON.stringify(bad);
  const rejected = prepared.verify(corrupted);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.diagnostics.some(entry => entry.code === "readback.form.mobile_grid_mismatch"));

  const native = JSON.parse(readFileSync(new URL("../fixtures/executor/persistence/shared-source-tracks-native.json", import.meta.url), "utf8"));
  for (const entry of Object.values(native.functions)) assert.equal(hash(entry.text), entry.sha256);
  const expand = runInNewContext("(" + native.functions.expandColsStyle.text + ")");
  const tracks = runInNewContext("(" + native.functions.getColsStyle.text + ")", { h: expand, o: value => typeof value });
  assert.deepEqual([...tracks([{ startIndex: 0, count: 4, value: "minmax(0, 1fr)" }], 4)], Array(4).fill("minmax(0, 1fr)"));
});

it("a two-thirds folded caption rejects the whole root under the existing native half-width contract", () => {
  const draft = stage("wide-caption"), result = plan(draft, "wide-caption");
  assert.equal(result.admitted, false);
  assert.match(result.detail, /native-folded-caption-share-exceeds-half/);
  assertBaselineGeometry(draft, "wide-caption");
  const prepared = prepareSample(draft);
  assertProtectedNative(xformConfig(prepared.update), "wide-caption");
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("a real independent nested table beside rowspan cells remains outside the common root axis", () => {
  const draft = stage("nested-same-axis"), result = plan(draft, "nested-same-axis");
  assert.equal(result.admitted, false);
  assert.equal(result.reason, "inconsistent-declared-root-axis");
  assertBaselineGeometry(draft, "nested-same-axis");
  const prepared = prepareSample(draft);
  assertProtectedNative(xformConfig(prepared.update), "nested-same-axis");
  assert.equal(prepared.verify(prepared.update).ok, true);
});
