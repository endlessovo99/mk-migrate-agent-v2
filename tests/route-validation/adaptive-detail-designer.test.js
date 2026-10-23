import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { ADAPTIVE_MAIN_FIELD_CLASS, adaptiveStyles } from "../../src/executor/persistence/adaptive-layout.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { renderNativeDesignerLayout, matchingDesignerNodes } from "../helpers/native-designer-layout.js";

const native = new URL("../fixtures/executor/persistence/adaptive-layout-native/designer/", import.meta.url);
const read = file => readFileSync(new URL(file, native), "utf8");
const nativeSelectors = read("detail-container.css").split("{")[0].split(",");
const fixtures = [
  "tests/fixtures/route-validation/hidden-detail-data-column/route-hidden-detail-data-column_SysFormTemplate.xml",
  "tests/fixtures/route-validation/structural-recovery/route-structural-recovery-inline-content_SysFormTemplate.xml"
];

it("retains the captured native designer modules and unmodified detail flex rule", () => {
  for (const [file, evidence] of Object.entries(JSON.parse(read("provenance.json")).files)) {
    assert.equal(createHash("sha256").update(read(file)).digest("hex"), evidence.sha256, file);
  }
  assert.match(read("detail-container.css"), /display:flex/);
  assert.ok(nativeSelectors.every(selector => selector.includes(".ele-xform-appearance>.receiver ")));
});

for (const fixture of fixtures) for (const scene of ["desktop", "mobile"]) {
  it(`${scene}: XML detail tables retain native designer flex and adaptive titles: ${fixture}`, () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const prepared = prepareSample(dsl);
    const config = xformConfig(prepared.update);
    const tree = renderNativeDesignerLayout(config, scene);
    const details = matchingDesignerNodes(tree, ".sys-xform-ide-detail-table-container");
    assert.ok(details.length > 0);
    const selector = nativeSelectors[scene === "desktop" ? 0 : 1];
    assert.equal(matchingDesignerNodes(tree, selector).length, details.length,
      "Native detail containers must match the upstream horizontal flex selector");
    const { scope } = adaptiveStyles(config.dataModel.find(model => model.fdType === "main").fdTableName);
    const css = JSON.parse(config.viewModel[0].fdConfig).view.render[scene][0];
    const findCarrier = node => node.controlProps?.dangerouslySetInnerHTML ? node
      : (node.children || []).map(findCarrier).find(Boolean);
    const selectors = [...findCarrier(css).controlProps.dangerouslySetInnerHTML.__html.slice(7, -8).matchAll(/([^{}]+)\{/g)]
      .flatMap(match => match[1].trim().split(",").map(value => value.trim()));
    assert.ok(selectors.every(value => value.startsWith(`.${scope} `)));
    const mainFieldCount = matchingDesignerNodes(tree, `.${ADAPTIVE_MAIN_FIELD_CLASS}`).length;
    assert.ok(selectors.every(value => mainFieldCount === 0
      ? matchingDesignerNodes(tree, value).length === 0 : matchingDesignerNodes(tree, value).length > 0),
    "Main fields retain adaptive declarations while detail-only layouts retain native styles");
    const detailLabels = matchingDesignerNodes(tree, ".sys-xform-ide-detail-table .ele-xform-fieldset-label");
    const adaptiveLabels = matchingDesignerNodes(tree, selectors[0]);
    assert.ok(detailLabels.length > 0);
    assert.ok(detailLabels.every(label => !adaptiveLabels.includes(label)),
      "Adaptive main-field wrapping must never alter native detail headers");
    assert.equal(prepared.verify(prepared.update).ok, true);

    // Reintroducing only the former wrapper must lose the real native CSS match.
    const changed = structuredClone(config);
    const view = JSON.parse(changed.viewModel[0].fdConfig);
    const appearance = view.view.render[scene][0];
    const main = appearance.children.find(node => node.type === "main");
    const marker = appearance.children.find(node => node.type === "div");
    if (main) { marker.children.push(main); appearance.children = [marker]; }
    changed.viewModel[0].fdConfig = JSON.stringify(view);
    assert.equal(matchingDesignerNodes(renderNativeDesignerLayout(changed, scene), selector).length, 0);
    const broken = structuredClone(prepared.update);
    broken.mechanisms["sys-xform"].fdConfig = JSON.stringify(changed);
    assert.equal(prepared.verify(broken).ok, false, "Readback must reject the former incompatible wrapper");
  });
}

it("scopes sibling-based adaptive declarations to one form and verifies marker order", () => {
  const dsl = draftSourceDraft(cleanSourceFile(fixtures[1]));
  const first = prepareSample(dsl, { envelope: { tableName: "mk_adaptive_first" } });
  const second = prepareSample(dsl, { envelope: { tableName: "mk_adaptive_second" } });
  for (const scene of ["desktop", "mobile"]) {
    const alpha = renderNativeDesignerLayout(xformConfig(first.update), scene);
    const beta = renderNativeDesignerLayout(xformConfig(second.update), scene);
    const { scope } = adaptiveStyles("mk_adaptive_first");
    const selector = `.${scope} ~ * .${ADAPTIVE_MAIN_FIELD_CLASS} .ele-xform-fieldset-label`;
    const targets = matchingDesignerNodes(alpha, selector);
    assert.ok(targets.length > 0);
    assert.equal(matchingDesignerNodes(beta, selector).length, 0);
    assert.deepEqual(matchingDesignerNodes({ type: "root", props: {}, children: [alpha, beta] }, selector), targets);

    const changed = structuredClone(first.update);
    const config = xformConfig(changed), view = JSON.parse(config.viewModel[0].fdConfig);
    view.view.render[scene][0].children.reverse();
    config.viewModel[0].fdConfig = JSON.stringify(view);
    changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    assert.equal(first.verify(changed).ok, false, "A marker after main cannot apply its stylesheet");
  }
});
