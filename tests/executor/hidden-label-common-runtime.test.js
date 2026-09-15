import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { COMPONENT_CATALOG, componentSupportsProp } from "../../src/dsl/catalogs.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixtureRoot = new URL("../fixtures/executor/persistence/hidden-label-runtime/", import.meta.url);
const runtimeSource = readFileSync(new URL("xform-fieldset.cjs", fixtureRoot), "utf8");
const provenance = JSON.parse(readFileSync(new URL("provenance.json", fixtureRoot), "utf8"));
const newComponents = [
  { componentId: "xform-button", type: "button" },
  { componentId: "xform-hyperlinks", type: "text" },
  { componentId: "xform-subject", type: "text" },
  { componentId: "xform-datetime", type: "dateTime" },
  { componentId: "xform-number", type: "number" },
  { componentId: "xform-calculate", type: "number" },
  { componentId: "xform-attach", type: "attachment" },
  { componentId: "xform-detail-table", type: "detailTable" }
];

describe("shared native field wrapper hidden-label contract", () => {
  it("retains the identical upstream desktop and mobile fieldset module", () => {
    const digest = createHash("sha256").update(runtimeSource).digest("hex");
    assert.deepEqual(provenance.sources.map((source) => source.platform), ["desktop", "mobile"]);
    for (const source of provenance.sources) assert.equal(source.moduleSha256, digest);
    for (const fragment of Object.values(provenance.mechanism)) assert.ok(runtimeSource.includes(fragment));
  });

  it("declares the common title contract for every rendered field wrapper", () => {
    for (const component of COMPONENT_CATALOG.components) {
      const expected = component.kind === "field" &&
        !["xform-hidden", "xform-description"].includes(component.componentId);
      assert.equal(componentSupportsProp(component.componentId, "hiddenLabel"), expected, component.componentId);
    }
    assert.equal(componentSupportsProp("xform-calculate", "unit"), false);
  });

  for (const testCase of newComponents) {
    it(`hides only the native wrapper title of ${testCase.componentId} on both platforms`, () => {
      const { dsl, fieldId } = componentDsl(testCase);
      const validation = checkExecute(dsl);
      assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));
      const prepared = prepareSample(dsl);
      const attribute = nativeAttribute(prepared.update, fieldId);
      const readback = prepared.verify(prepared.update);
      assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
      assert.equal(readback.form.fields.find((field) => field.id === fieldId)?.hiddenLabel, true);

      for (const platform of ["desktop", "mobile"]) {
        assert.equal(attribute.config.controlProps[platform].hiddenLabel, true);
        assert.equal(attribute.config.labelProps[platform].hiddenLabel, true);
        const hidden = renderNativeWrapper(attribute, platform);
        assert.equal(wrapperLabels(hidden).length, 0, `${platform}: hidden wrapper title`);
        assert.equal(findNodes(hidden, (node) => node.type === "fixture-control").length, 1);

        const visible = structuredClone(attribute);
        delete visible.config.labelProps[platform].hiddenLabel;
        assert.equal(wrapperLabels(renderNativeWrapper(visible, platform)).length, 1,
          `${platform}: the same upstream wrapper renders the title without hiddenLabel`);
      }
      if (testCase.componentId === "xform-calculate") {
        assert.equal(attribute.config.controlProps.numberFormat, undefined);
      }
    });

    it(`rejects a lost native title flag for ${testCase.componentId}`, () => {
      const { dsl, fieldId } = componentDsl(testCase);
      const prepared = prepareSample(dsl);
      const corrupt = structuredClone(prepared.update);
      const config = xformConfig(corrupt);
      const field = nativeNode(config, fieldId);
      const attribute = JSON.parse(field.fdAttribute);
      delete attribute.config.labelProps.desktop.hiddenLabel;
      field.fdAttribute = JSON.stringify(attribute);
      corrupt.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
      const result = prepared.verify(corrupt);
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some((diagnostic) =>
        diagnostic.code === "readback.form.prop_hiddenLabel_mismatch"));
    });
  }
});

function componentDsl({ componentId, type }) {
  const dsl = sampleTrustedDsl({ workflow: null });
  delete dsl.workflow;
  const fieldId = type === "detailTable" ? "fd_detail" : "fd_subject";
  const field = dsl.form.fields.find((candidate) => candidate.id === fieldId);
  Object.assign(field, { type, componentId, props: { hiddenLabel: true } });
  if (componentId === "xform-calculate") {
    const operand = dsl.form.fields.find((candidate) => candidate.id === "fd_amount");
    Object.assign(operand, { type: "number", componentId: "xform-number" });
    field.props.calculation = {
      kind: "formula", expression: "$fd_amount$ + 1", displayExpression: "$金额$ + 1", fieldIds: ["fd_amount"]
    };
  }
  if (componentId === "xform-button") {
    dsl.scripts = {
      source: "sysform-jsp",
      actions: [{
        id: "button-action", name: "onClick", event: "onClick", scope: "control",
        controlId: fieldId, translationStatus: "mapped",
        coverage: { status: "translated", nativeRules: [], residuals: [] },
        functionMappings: [{ source: "return true", target: "return true", basis: "external-agent" }],
        function: "function onClick() { return true; }"
      }]
    };
  }
  return { dsl, fieldId };
}

function nativeAttribute(template, fieldId) {
  const config = xformConfig(template);
  const field = nativeNode(config, fieldId);
  return JSON.parse(field.fdAttribute);
}

function nativeNode(config, fieldId) {
  return config.dataModel.find((model) => model.fdType === "detail" && model.fdCode === fieldId) ||
    config.dataModel.flatMap((model) => model.fdFields || [])
      .find((candidate) => candidate.fdName === fieldId);
}

function renderNativeWrapper(attribute, platform) {
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: "fragment",
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useMemo: (callback) => callback(),
    useCallback: (callback) => callback,
    useRef: (current) => ({ current }),
    useEffect: () => {}
  };
  const dependencies = {
    react,
    "@elem/xform-base": {
      getShowStatus: () => "edit", useFormatValidate: () => ({}),
      isRedValidatorInfoUITypeThemes: () => false, getSeparator: () => ","
    },
    "@lui/core": {}, "@mui/core": {},
    "@ekp-infra/common": { Module: { getComponent: () => "unused-ai-popover" } },
    "@ekp-runtime/utils": { appendTestAttr: () => ({}), appendTestAttrWithoutCheck: () => ({}) }
  };
  const exports = {};
  runInNewContext(runtimeSource, {
    exports, module: { exports },
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected upstream dependency: ${name}`);
      return dependencies[name];
    },
    mk: { getSysConfig: () => platform, on: () => {}, off: () => {} }
  }, { timeout: 1000 });
  const { labelProps, controlProps } = attribute.config;
  return exports.default({
    ...labelProps, ...labelProps[platform],
    $$platform: platform, $$controlType: controlProps[platform].type,
    currentStatus: "runtime", showStatus: "edit",
    children: react.createElement("fixture-control", { id: controlProps.id, name: controlProps.name }, "retained-value")
  });
}

function wrapperLabels(tree) {
  return findNodes(tree, (node) => node.props?.className?.split(" ").includes("ele-xform-fieldset-label"));
}

function findNodes(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap((child) => findNodes(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...findNodes(tree.children, predicate)];
}
