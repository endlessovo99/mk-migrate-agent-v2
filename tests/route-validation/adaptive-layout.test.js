import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { renderNativeFieldReferences } from "../helpers/native-form-renderer.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/adaptive-layout/adaptive-layout_SysFormTemplate.xml";
const scenes = ["desktop", "mobile"];
const editorIds = ["fd_department", "fd_start", "fd_end", "fd_amount", "fd_reason", "fd_summary"];

it("passes review, planning, fake execution and readback with the adaptive native contract", async () => {
  const result = await runRouteCase("adaptive-layout-success");
  assert.equal(result.dsl.form.layout.sizing, "adaptive");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.readback.partitions.form, "verified");
  assert.equal(result.execution.transferRecord.status, "recorded");
});

for (const path of [
  "business-card-layout/route-business-card-layout_SysFormTemplate.xml",
  "leader-leave-layout/route-leader-leave-layout_SysFormTemplate.xml",
  "staff-demand-title/route-staff-demand_SysFormTemplate.xml",
  "rowspan-section-caption/route-rowspan-section-caption_SysFormTemplate.xml",
  "static-jsp-caption-evidence/static-jsp-caption_SysFormTemplate.xml"
]) it(`keeps field semantics and topology across both sizing policies: ${path}`, () => {
  const { adaptive, retained } = stages(`tests/fixtures/route-validation/${path}`);
  assert.deepEqual(adaptive.form.fields, retained.form.fields);
  assert.deepEqual(adaptive.form.layout.sourceGrid, retained.form.layout.sourceGrid);
  const next = projection(adaptive), old = projection(retained);
  for (const scene of scenes) {
    assertAutomaticColumns(next.view.view.render[scene][0]);
    assert.deepEqual(topology(next.view.view.render[scene][0]), topology(old.view.view.render[scene][0]));
    assert.deepEqual(renderNativeFieldReferences(next.config, scene).actual,
      renderNativeFieldReferences(old.config, scene).actual);
  }
  assert.equal(next.prepared.verify(next.prepared.update).ok, true);
  assert.equal(old.prepared.verify(old.prepared.update).ok, true);
});

function stages(path = fixture) {
  const source = cleanSourceFile(path);
  return {
    source,
    adaptive: draftSourceDraft(source),
    retained: draftSourceDraft(source, { layoutSizing: "source" })
  };
}

function projection(dsl) {
  const prepared = prepareSample(dsl);
  const config = xformConfig(prepared.update);
  const view = JSON.parse(config.viewModel[0].fdConfig);
  return { prepared, config, view };
}

function nodes(node) {
  return [node, ...(node.children || []).flatMap(nodes)];
}

function parentOf(node, id) {
  return nodes(node).find(item => item.children?.some(child => child.key === id));
}

function grids(root) {
  return nodes(root).filter(node => node.type === "@elem/layout-grid");
}

function topology(root) {
  return nodes(root).filter(node => node.type === "@elem/layout-grid.GridItem").map(node => {
    const p = node.controlProps;
    return {
      column: p.column,
      columnSpan: p.columnSpan,
      row: p.row,
      rowSpan: p.rowSpan,
      fields: p.migrationFieldIds
    };
  });
}

function assertAutomaticColumns(root) {
  const found = grids(root);
  assert.ok(found.length > 0, "The sample must actually contain native grid layouts");
  for (const grid of found) {
    const { columns, colsStyle } = grid.controlProps;
    assert.ok(Array.isArray(colsStyle), "Omitting colsStyle would restore equal fixed percentages");
    const expanded = [];
    for (const item of colsStyle) {
      assert.equal(item.value, "auto");
      for (let column = item.startIndex; column < item.startIndex + item.count; column += 1) {
        assert.equal(expanded[column], undefined, "A column must not receive conflicting sizing rules");
        expanded[column] = item.value;
      }
    }
    assert.deepEqual(expanded, Array(columns).fill("auto"));
  }
}

function reviewed(source, dsl) {
  return createTrustedMigrationDsl(source, dsl, {
    externalAgentReviewed: true,
    reviewerName: "synthetic adaptive layout regression",
    checkedAt: "2026-10-20T00:00:00Z"
  });
}

function changedView(prepared, mutate) {
  const changed = structuredClone(prepared.update);
  const config = xformConfig(changed);
  const view = JSON.parse(config.viewModel[0].fdConfig);
  mutate(view);
  config.viewModel[0].fdConfig = JSON.stringify(view);
  changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  return changed;
}

function adaptiveCarrier(view, scene) {
  const appearance = view.view.render[scene][0];
  const carriers = nodes(appearance).filter(node => node.type === "@elem/xform-html");
  assert.equal(carriers.length, 1, `${scene} must mount exactly one CSS-only carrier`);
  const carrier = carriers[0];
  const scope = parentOf(appearance, carrier.key);
  return { appearance, scope, carrier };
}

it("defaults fresh XML to adaptive sizing without rewriting source geometry or field semantics", () => {
  const { source, adaptive, retained } = stages();
  assert.equal(adaptive.form.layout.sizing, "adaptive");
  assert.equal(Object.hasOwn(retained.form.layout, "sizing"), false);
  assert.deepEqual(adaptive.form.layout.sourceGrid, source.form.layout);
  assert.deepEqual(adaptive.form.layout.sourceGrid, retained.form.layout.sourceGrid);
  assert.deepEqual(adaptive.form.layout.mkTree, retained.form.layout.mkTree);
  assert.deepEqual(adaptive.form.fields, retained.form.fields);

  const department = adaptive.form.fields.find(field => field.id === "fd_department");
  assert.equal(department.title, "申请部门");
  assert.equal(department.props.required, true);
  assert.equal(department.props.readOnly, true);
  assert.deepEqual(department.props.defaultValue, { kind: "literal", value: "运营部" });
  assert.notEqual(department.props.hiddenLabel, true);
  assert.equal(adaptive.form.fields.some(field => field.id === "department_caption"), false);
  assert.equal(adaptive.form.fields.find(field => field.id === "range_caption").props.content, "查询范围");
});

it("sets every desktop and mobile grid column explicitly to auto while preserving merged cells", () => {
  const { adaptive, retained } = stages();
  const next = projection(adaptive), old = projection(retained);
  for (const scene of scenes) {
    const root = next.view.view.render[scene][0];
    assertAutomaticColumns(root);
    assert.deepEqual(topology(root), topology(old.view.view.render[scene][0]));
    assert.ok(topology(root).some(cell => cell.columnSpan > 1), "Exercise a real merged caption/input region");
  }
});

it("lets pixel and percentage editors grow and shrink while keeping descriptive units intrinsic", () => {
  const { adaptive } = stages(), { view } = projection(adaptive);
  for (const scene of scenes) {
    const root = view.view.render[scene][0];
    for (const id of editorIds) {
      const wrapper = parentOf(root, id);
      assert.equal(wrapper?.type, "div", `${scene}: ${id} must remain renderable by NewOA`);
      const style = wrapper.controlProps.style;
      assert.match(style.flex, /^1 1 /, `${scene}: ${id} must consume available space`);
      assert.ok(["auto", "100%"].includes(style.width), `${scene}: ${id} must not keep source pixel/percentage width`);
      assert.equal(style.minWidth, 0);
      assert.equal(style.maxWidth, "100%");
    }
    for (const id of ["range_caption", "range_separator", "amount_note", "amount_unit"]) {
      const style = parentOf(root, id).controlProps.style;
      assert.match(style.flex, /^0 /, `${id} must not stretch like an editor`);
      assert.notEqual(style.width, "100%", `${id} must not force the following editor onto a new line`);
    }
  }
});

it("preserves explicit breaks, source width evidence, zero-width companions and hidden values", () => {
  const { adaptive, retained } = stages();
  const next = projection(adaptive), old = projection(retained);
  const sourceItems = adaptive.form.layout.sourceGrid.rows.flatMap(row =>
    row.cells.flatMap(cell => cell.contentFlow?.items || []));
  assert.deepEqual(sourceItems.find(item => item.referenceId === "fd_start").width, { value: 90, unit: "px" });
  assert.deepEqual(sourceItems.find(item => item.referenceId === "fd_end").width, { value: 40, unit: "%" });
  for (const scene of scenes) {
    const root = next.view.view.render[scene][0];
    const zeroStyle = parentOf(root, "fd_zero_companion").controlProps.style;
    assert.equal(zeroStyle.width, "0px");
    assert.match(zeroStyle.flex, /^0 0 /);
    assert.equal(parentOf(root, "fd_hidden"), undefined);
    const rendered = renderNativeFieldReferences(next.config, scene);
    assert.deepEqual(rendered.actual, rendered.expected);
    assert.deepEqual(rendered.actual, renderNativeFieldReferences(old.config, scene).actual);
    assert.ok(rendered.actual.includes("fd_amount"));
    assert.ok(rendered.actual.includes("amount_unit"));
    const firstLine = parentOf(root, parentOf(root, "fd_start").key);
    assert.deepEqual(firstLine.children.flatMap(item => item.children.map(child => child.key)),
      ["fd_start", "range_separator", "fd_end"]);
    assert.equal(firstLine.controlProps.style.flexWrap, "wrap");
    assert.notEqual(firstLine.key, parentOf(root, parentOf(root, "fd_zero_companion").key).key);
  }
});

it("keeps retained DSL without a sizing flag on its original pixel and proportional-width policy", () => {
  const { adaptive, retained } = stages();
  const original = projection(retained);
  const noFlag = structuredClone(adaptive);
  delete noFlag.form.layout.sizing;
  const replay = projection(noFlag);
  assert.deepEqual(replay.view, original.view);
  for (const scene of scenes) {
    const root = original.view.view.render[scene][0];
    assert.equal(parentOf(root, "fd_start").controlProps.style.width, "90px");
    assert.equal(parentOf(root, "fd_end").controlProps.style.width, "40%");
    assert.ok(grids(root).some(grid => grid.controlProps.colsStyle.some(item => item.value.endsWith("%"))));
  }
  assert.equal(original.prepared.verify(original.prepared.update).ok, true);
});

it("accepts both reviewed policies but rejects unsupported sizing and altered source evidence", () => {
  const { source, adaptive, retained } = stages();
  for (const draft of [adaptive, retained]) {
    const trusted = reviewed(source, draft);
    assert.equal(checkTrust(source, trusted).ok, true);
  }
  const unsupported = reviewed(source, adaptive);
  unsupported.form.layout.sizing = "unreviewed-dynamic-width";
  assert.equal(checkTrust(source, unsupported).ok, false);
  const forged = reviewed(source, adaptive);
  forged.form.layout.sourceGrid.rows[0].cells[0].widthWeight = 999;
  assert.equal(checkTrust(source, forged).ok, false);
});

it("round-trips adaptive native persistence on both scenes with unchanged field and flow identities", () => {
  const { adaptive } = stages(), { prepared } = projection(adaptive);
  const result = prepared.verify(prepared.update);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const mixed = result.form.layoutRows.flatMap(row => row.cells)
    .find(cell => cell.fieldIds.includes("fd_start"));
  assert.deepEqual(mixed.contentFlow.lines, [
    ["fd_start", "range_separator", "fd_end"], ["fd_zero_companion"]
  ]);
  assert.equal(result.form.fields.find(field => field.id === "fd_department").title, "申请部门");
});

for (const scene of scenes) {
  it(`rejects ${scene} fixed grid bounds or extra presentation nodes outside the declared rows`, () => {
    const { prepared } = projection(stages().adaptive);
    assert.equal(prepared.verify(prepared.update).ok, true);
    for (const mutate of [
      view => { grids(view.view.render[scene][0])[0].controlProps.style = { maxWidth: "1px" }; },
      view => {
        const main = nodes(view.view.render[scene][0]).find(node => node.key === "main");
        main.children.push({ key: "unexpected-style", type: "div", kind: "container",
          controlProps: { dangerouslySetInnerHTML: { __html: "<style>body{display:none}</style>" } }, children: [] });
      }
    ]) assert.equal(prepared.verify(changedView(prepared, mutate)).ok, false);
  });

  it(`rejects ${scene} readback if an automatic column becomes a fixed percentage`, () => {
    const { prepared } = projection(stages().adaptive);
    assert.equal(prepared.verify(prepared.update).ok, true);
    const changed = changedView(prepared, view => {
      grids(view.view.render[scene][0])[0].controlProps.colsStyle[0].value = "50%";
    });
    assert.equal(prepared.verify(changed).ok, false);
  });

  it(`rejects ${scene} readback if an editor silently regains a fixed source width`, () => {
    const { prepared } = projection(stages().adaptive);
    assert.equal(prepared.verify(prepared.update).ok, true);
    const changed = changedView(prepared, view => {
      parentOf(view.view.render[scene][0], "fd_start").controlProps.style.width = "90px";
    });
    assert.equal(prepared.verify(changed).ok, false);
  });
}

it("applies automatic columns to nested layouts without changing their flattened topology", () => {
  const { adaptive, retained } = stages(
    "tests/fixtures/route-validation/mobile-mixed-caption/nested-grid_SysFormTemplate.xml"
  );
  const next = projection(adaptive), old = projection(retained);
  for (const scene of scenes) {
    const root = next.view.view.render[scene][0];
    assertAutomaticColumns(root);
    assert.deepEqual(topology(root), topology(old.view.view.render[scene][0]));
    assert.deepEqual(renderNativeFieldReferences(next.config, scene).actual,
      renderNativeFieldReferences(old.config, scene).actual);
  }
  assert.equal(next.prepared.verify(next.prepared.update).ok, true);
});

it("derives the same adaptive policy after changing all field identities, labels and source dimensions", () => {
  const directory = mkdtempSync(join(tmpdir(), "adaptive-layout-"));
  try {
    const path = join(directory, "renamed_SysFormTemplate.xml");
    const longTitle = "需要完整显示而不能受默认八个字宽度限制的申请部门名称";
    const xml = readFileSync(fixture, "utf8")
      .replace(/\bfd_(?!type\b|values\b)/g, "renamed_")
      .replaceAll("申请部门", longTitle)
      .replaceAll("120px", "333px")
      .replaceAll('width:"120"', 'width:"333"')
      .replaceAll('width="160"', 'width="220"')
      .replaceAll('width="400"', 'width="600"')
      .replaceAll('width="560"', 'width="820"');
    writeFileSync(path, xml);
    const { source, adaptive } = stages(path), { prepared, config, view } = projection(adaptive);
    assert.equal(adaptive.form.layout.sizing, "adaptive");
    assert.equal(adaptive.form.fields.find(field => field.id === "renamed_department").title, longTitle);
    assert.equal(checkTrust(source, reviewed(source, adaptive)).ok, true);
    for (const scene of scenes) {
      const root = view.view.render[scene][0];
      assertAutomaticColumns(root);
      assert.match(parentOf(root, "renamed_department").controlProps.style.flex, /^1 1 /);
      assert.doesNotMatch(parentOf(root, "renamed_department").controlProps.style.width, /px$/);
      const rendered = renderNativeFieldReferences(config, scene);
      assert.deepEqual(rendered.actual, rendered.expected);
      assert.ok(rendered.actual.includes("renamed_department"));
      assert.equal(rendered.actual.includes("fd_department"), false);
    }
    assert.equal(prepared.verify(prepared.update).ok, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("mounts CSS through the native HTML control inside a form-specific scope without adding business fields", () => {
  const { adaptive, retained } = stages();
  const next = projection(adaptive), old = projection(retained);
  assert.deepEqual(
    next.config.dataModel.map(model => model.fdFields.map(field => field.fdName)),
    old.config.dataModel.map(model => model.fdFields.map(field => field.fdName))
  );
  const scopeNames = [];
  for (const scene of scenes) {
    const { scope, carrier } = adaptiveCarrier(next.view, scene);
    assert.equal(scope.type, "div", "Use NewOA's registered native container");
    const scopeName = scope.controlProps.className;
    assert.match(scopeName, /^mk-adaptive-[a-zA-Z0-9_-]+$/);
    scopeNames.push(scopeName);
    assert.ok(nodes(scope).some(node => node.key === "main"), "CSS and business controls must share their scope");
    assert.equal(carrier.kind, "control");
    assert.equal(carrier.controlProps.$$isDesign, false, "The CSS carrier must mount in the designer too");
    const { html, css, javascript } = carrier.controlProps.source;
    assert.equal(html, "");
    assert.equal(javascript, "");
    assert.match(css, /\.ele-xform-fieldset-label/);
    assert.match(css, /width\s*:\s*auto\s*!important/);
    assert.match(css, /max-width\s*:\s*none\s*!important/);
    const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(match => match[1].trim().split(","));
    assert.ok(selectors.length > 1, "Exercise the outer title and inner text rules");
    for (const selector of selectors) {
      assert.ok(selector.trim().startsWith(`.${scopeName}`),
        `Every generated selector must stay within this form: ${selector}`);
    }
  }
  assert.equal(scopeNames[0], scopeNames[1], "Desktop and mobile render the same template scope");
  assert.equal(next.prepared.verify(next.prepared.update).ok, true);
});

for (const scene of scenes) {
  for (const [name, mutate] of [
    ["removed carrier", ({ scope, carrier }) => {
      scope.children = scope.children.filter(node => node.key !== carrier.key);
    }],
    ["changed title CSS", ({ carrier }) => {
      carrier.controlProps.source.css = carrier.controlProps.source.css.replace(
        /width\s*:\s*auto\s*!important/, "width:8em!important"
      );
    }],
    ["unexpected executable JavaScript", ({ carrier }) => {
      carrier.controlProps.source.javascript = "globalThis.unapprovedMigrationScript = true;";
    }],
    ["carrier moved outside the form scope", ({ appearance, scope, carrier }) => {
      scope.children = scope.children.filter(node => node.key !== carrier.key);
      appearance.children.push(carrier);
    }],
    ["removed form scope", ({ scope }) => {
      delete scope.controlProps.className;
    }]
  ]) {
    it(`rejects ${scene} adaptive readback with ${name}`, () => {
      const { prepared } = projection(stages().adaptive);
      assert.equal(prepared.verify(prepared.update).ok, true);
      const changed = changedView(prepared, view => mutate(adaptiveCarrier(view, scene)));
      assert.equal(prepared.verify(changed).ok, false);
    });
  }
}
