import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { prepareSample } from "../helpers/persistence.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { applyEvidenceBackedPatches } from "../../src/agent-review/review-validation.js";
import { buildFormRuleRefIndex, resolveEffectTarget } from "../../src/dsl/form-rules.js";

const fixture = "tests/fixtures/route-validation/nested-standard-geometry/route-nested-standard-geometry_SysFormTemplate.xml";
const variant = name => `tests/fixtures/route-validation/nested-standard-geometry/${name}_SysFormTemplate.xml`;

function checkedRoute(path) {
  const source = cleanSourceFile(path), draft = draftSourceDraft(source);
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "nested source geometry route" });
  for (const result of [checkDraft(draft), checkTrust(source, trusted), checkExecute(trusted), buildDryRunPlan(trusted)]) {
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  }
  const prepared = prepareSample(trusted), readback = prepared.verify(prepared.update);
  assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
  return { source, draft, trusted, native: projectNativeLayoutRows(draft.form.layout.mkTree), readback };
}

function physicalBounds(row, cell) {
  const shares = row.colsStyle?.map(style => parseFloat(style.value) / 100) || Array(row.columns).fill(1 / row.columns);
  const start = shares.slice(0, cell.column).reduce((sum, value) => sum + value, 0);
  return [start, start + shares.slice(cell.column, cell.column + cell.colspan).reduce((sum, value) => sum + value, 0)];
}

it("preserves nested standard-table rowspan, occupied columns and trailing empty physical space through native persistence", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  assert.ok(source.form.layout.rows.flatMap(row => row.cells).some(cell => cell.rowspan === 2 &&
    cell.references.some(ref => ref.referenceId === "fd_span")));
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "nested source geometry route" });
  for (const result of [checkTrust(source, trusted), checkExecute(trusted), buildDryRunPlan(trusted)]) {
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  }
  const [row] = projectNativeLayoutRows(draft.form.layout.mkTree);
  const span = row.cells.find(cell => cell.refIds.includes("fd_span"));
  const delta = row.cells.find(cell => cell.refIds.includes("fd_delta"));
  assert.equal(row.rows, 2);
  assert.equal(span.rowspan, 2);
  assert.equal(delta.row, 1);
  const spanBounds = physicalBounds(row, span), deltaBounds = physicalBounds(row, delta);
  assert.ok(Math.abs(spanBounds[0]) < 1e-10);
  assert.ok(Math.abs(spanBounds[1] - 1 / 4) < 1e-10);
  assert.ok(Math.abs(deltaBounds[0] - 1 / 4) < 1e-10, "the preceding source rowspan still occupies column zero");
  assert.ok(Math.abs(deltaBounds[1] - 1 / 2) < 1e-10, "the two empty trailing source cells retain half the table width");
  const prepared = prepareSample(trusted), readback = prepared.verify(prepared.update);
  assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
  const persisted = readback.form.layoutRows.find(layout => layout.rootNodeId === row.id);
  assert.equal(persisted.cells.find(cell => cell.fieldIds.includes("fd_span")).rowspan, 2);
});

it("retains covered source-row marker ownership without widening it to the span owner", () => {
  const { source, draft, readback } = checkedRoute(variant("covered-marker"));
  const rows = source.form.layout.rows.filter(row => row.sourceMarkers?.includes("fd_child_row"));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].cells.flatMap(cell => cell.references.map(ref => ref.referenceId)), ["fd_delta"]);
  const target = resolveEffectTarget(buildFormRuleRefIndex(draft.form), "fd_child_row");
  assert.deepEqual(target.targets.map(field => field.id), ["fd_delta"]);
  assert.equal(draft.form.layout.mkTree.filter(row => row.sourceMarkers?.includes("fd_child_row")).length, 1);
  assert.ok(readback.form.layoutRows.flatMap(row => row.cells).some(cell => cell.fieldIds.includes("fd_delta")));
});

it("keeps a shared four-column basis even when a no-span row ends in empty TDs", () => {
  const { native: [row] } = checkedRoute(variant("no-span-trailing"));
  const delta = row.cells.find(cell => cell.refIds.includes("fd_delta"));
  assert.equal(delta.row, 1);
  assert.deepEqual(physicalBounds(row, delta).map(value => Math.round(value * 1000)), [0, 250]);
});

it("preserves sequential independent rowspans of two and three in one nested table", () => {
  const { source, native: [row] } = checkedRoute(variant("sequential-spans"));
  assert.equal(row.rows, 5);
  assert.deepEqual(["fd_span", "fd_second_span"].map(id => {
    const cell = row.cells.find(cell => cell.refIds.includes(id));
    return [cell.row, cell.rowspan, ...physicalBounds(row, cell).map(value => Math.round(value * 1000))];
  }), [[0, 2, 0, 250], [2, 3, 0, 250]]);
  const refs = source.form.layout.rows.flatMap(row => row.cells.flatMap(cell => cell.references));
  const layoutIds = new Set(source.form.layout.rows.map(row => row.id));
  assert.ok(refs.filter(ref => ref.referenceType === "layout").every(ref => layoutIds.has(ref.referenceId)));
});

it("retains legacy catalog-limited wrapping and field order for a ten-column table without spans", () => {
  const { source, draft, native: [row] } = checkedRoute(variant("wide-wrap"));
  const sourceRow = source.form.layout.rows.find(row => row.id === "row-0.nested-0.row-0");
  assert.equal(sourceRow.columns, 10);
  assert.equal(sourceRow.preserveSourceGeometry, undefined);
  assert.equal(draft.form.layout.mkTree.find(row => row.id === "layout.row-0.nested-0.row-0").props.columns, 8);
  assert.deepEqual(row.cells.flatMap(cell => cell.refIds), Array.from({ length: 10 }, (_,index) => `fd_wide_${index}`));
  assert.equal(row.rows, 2);
});

for (const name of ["multiple-span", "non-left-span", "incomplete-span", "conflicting-columns", "adjacent-table-boundary", "first-marker", "wide-span", "wide-colspan", "unrepresented-span"]) {
  it(`independently rejects washed ${name} metadata against the unchanged Source Draft`, () => {
    const source = cleanSourceFile(variant(name)), draft = draftSourceDraft(source);
    draft.review.errors = [];
    const candidate = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
    candidate.review.errors = [];
    assert.equal(checkTrust(source, candidate).ok, false);
    assert.equal(applyEvidenceBackedPatches(draft, [], { sourceDraft: source }).ok, false);
  });
  it(`rejects unproven nested ${name} geometry through draft, trust, execute and fixed-source patch checks`, () => {
    const source = cleanSourceFile(variant(name)), draft = draftSourceDraft(source);
    assert.ok(source.issues.some(issue => issue.level === "error" && issue.code === "source.sysform.nested_geometry_unproven"));
    assert.equal(checkDraft(draft).ok, false);
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "unsupported geometry" });
    for (const result of [checkTrust(source, trusted), checkExecute(trusted), buildDryRunPlan(trusted)]) {
      assert.equal(result.ok, false, `${name} must not execute with discarded source spans or widened marker membership`);
    }
    for (const errors of [[], [{ code: "unrelated", message: "forged replacement", path: "/review" }]]) {
      const washed = structuredClone(draft);
      washed.review.errors = errors;
      washed.review.warnings = [];
      washed.review.coverage = { status: "translated", sourceGeometryVerified: true };
      const candidate = createTrustedMigrationDsl(source, washed, { externalAgentReviewed: true, reviewerName: "forged metadata" });
      candidate.review.errors = [];
      const trust = checkTrust(source, candidate);
      assert.equal(trust.ok, false);
      assert.ok(trust.diagnostics.some(diagnostic => diagnostic.code === "source.sysform.nested_geometry_unproven"));
      const apply = applyEvidenceBackedPatches(washed, [], { sourceDraft: source });
      assert.equal(apply.ok, false);
      assert.ok(apply.diagnostics.some(diagnostic => diagnostic.code === "source.sysform.nested_geometry_unproven"));
    }
  });
}
