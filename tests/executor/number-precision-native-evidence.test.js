import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

describe("independent numeric precision native evidence", () => {
  for (const precision of [0, 2, 3]) {
    it(`writes ${precision} decimal places to every native precision mirror`, () => {
      const prepared = prepareSample(precisionDsl(precision));

      for (const fieldId of ["fd_amount", "fd_name"]) {
        assertNativePrecision(nativeNumber(prepared.update, fieldId), precision);
      }
    });
  }

  it("preserves a localized unit while enforcing numeric precision", () => {
    const dsl = precisionDsl(2);
    dsl.form.fields.find((field) => field.id === "fd_amount").props.unit = "元";
    const prepared = prepareSample(dsl);
    const native = nativeNumber(prepared.update, "fd_amount");

    assert.equal(native.attribute.config.type, "numbertext");
    assert.equal(native.controlProps.valueType.precision, 2);
    assert.equal(native.controlProps.numberFormat.formatType, "decimal");
    assert.equal(native.controlProps.numberFormat.precision, "2");
    assert.match(native.controlProps.numberFormat.unit, /^!\{[^}]+\}$/u);
    assert.equal(native.fontExtendData.precision, "2");
    assert.equal(native.fontExtendData.unit, native.controlProps.numberFormat.unit);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });

  it("rejects a coordinated fallback to the unit-only base profile", () => {
    const dsl = precisionDsl(2);
    dsl.form.fields.find((field) => field.id === "fd_amount").props.unit = "元";
    const prepared = prepareSample(dsl);
    const template = structuredClone(prepared.update);
    mutateNativeNumber(template, "fd_amount", ({ controlProps, fontExtendData }) => {
      Object.assign(controlProps.numberFormat, {
        formatType: "base",
        percentage: false,
        groupingUsed: null
      });
      Object.assign(fontExtendData, {
        formatType: "base",
        percentage: false,
        groupingUsed: null
      });
    });

    assertPrecisionMismatch(prepared.verify(template), "fd_amount");
  });

  it("keeps calculated precision on its distinct native profile", () => {
    const prepared = prepareSample(calculatePrecisionDsl(2));
    const native = nativeNumber(prepared.update, "fd_amount");

    assert.equal(native.attribute.config.type, "@elem/xform-calculate");
    assert.equal(native.controlProps.numberFormat, undefined);
    assert.equal(native.controlProps.valueType.precision, 2);
    assert.equal(native.fontExtendData.precision, 2);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });

  for (const testCase of [
    {
      name: "ordinary number input mode",
      mutate({ attribute }) {
        attribute.config.type = "numbertext";
      }
    },
    {
      name: "ordinary number-format mirror",
      mutate({ controlProps }) {
        controlProps.numberFormat = {
          formatType: "decimal",
          percentage: null,
          precision: "2",
          groupingUsed: false,
          symbol: null,
          unit: ""
        };
      }
    }
  ]) {
    it(`rejects calculated precision with ${testCase.name}`, () => {
      const prepared = prepareSample(calculatePrecisionDsl(2));
      const template = structuredClone(prepared.update);
      mutateNativeNumber(template, "fd_amount", testCase.mutate);

      assertPrecisionMismatch(prepared.verify(template), "fd_amount");
    });
  }

  it("normalizes provably equal number and string precision mirrors, including zero", () => {
    const dsl = precisionDsl(0);
    const prepared = prepareSample(dsl);
    const template = structuredClone(prepared.update);
    mutateNativeNumber(template, "fd_amount", ({ controlProps }) => {
      controlProps.valueType.precision = "0";
      controlProps.numberFormat.precision = 0;
    });
    mutateNativeNumber(template, "fd_name", ({ fontExtendData }) => {
      fontExtendData.precision = 0;
    });

    assert.equal(prepared.verify(template).ok, true);
  });

  for (const testCase of [
    {
      name: "missing number-format precision",
      mutate({ controlProps }) {
        delete controlProps.numberFormat.precision;
      }
    },
    {
      name: "changed font precision",
      mutate({ fontExtendData }) {
        fontExtendData.precision = "4";
      }
    },
    {
      name: "non-native numeric config mode",
      mutate({ attribute }) {
        attribute.config.type = "@elem/xform-number";
      }
    },
    {
      name: "changed value-type format",
      mutate({ controlProps }) {
        controlProps.valueType.formatType = "base";
      }
    },
    {
      name: "changed value-type grouping",
      mutate({ controlProps }) {
        controlProps.valueType.groupingUsed = true;
      }
    }
  ]) {
    it(`rejects ${testCase.name} instead of trusting valueType alone`, () => {
      const dsl = precisionDsl(2);
      const prepared = prepareSample(dsl);
      const template = structuredClone(prepared.update);
      mutateNativeNumber(template, "fd_name", testCase.mutate);

      const readback = prepared.verify(template);

      assert.equal(readback.ok, false);
      assert.equal(
        readback.diagnostics.some((item) =>
          item.code === "readback.form.prop_precision_mismatch" &&
          item.details?.fieldId === "fd_detail" &&
          item.details?.columnId === "fd_name"
        ),
        true,
        JSON.stringify(readback.diagnostics)
      );
      assert.equal(
        readback.diagnostics.find((item) => item.code === "readback.form.prop_precision_mismatch")?.path,
        "/readback/form/fields/fd_detail/columns/fd_name/props"
      );
    });
  }

});

function precisionDsl(precision) {
  const dsl = sampleTrustedDsl({ workflow: null });
  const amount = dsl.form.fields.find((field) => field.id === "fd_amount");
  Object.assign(amount, {
    type: "number",
    componentId: "xform-number",
    props: { precision }
  });

  const detail = dsl.form.fields.find((field) => field.id === "fd_detail");
  Object.assign(detail.columns[0], {
    type: "number",
    componentId: "xform-number",
    props: { precision }
  });
  return dsl;
}

function calculatePrecisionDsl(precision) {
  const dsl = sampleTrustedDsl({ workflow: null });
  const amount = dsl.form.fields.find((field) => field.id === "fd_amount");
  Object.assign(amount, {
    type: "calculate",
    componentId: "xform-calculate",
    props: { precision }
  });
  return dsl;
}

function nativeNumber(template, fieldId) {
  const config = xformConfig(template);
  const field = config.dataModel
    .flatMap((model) => model.fdFields || [])
    .find((candidate) => candidate.fdName === fieldId);
  const attribute = JSON.parse(field.fdAttribute);
  return {
    config,
    field,
    attribute,
    controlProps: attribute.config.controlProps,
    fontExtendData: JSON.parse(field.fdFontExtendData)
  };
}

function assertNativePrecision(native, precision) {
  assert.equal(native.field.fdType, "number");
  assert.equal(native.field.fdDataType, "number");
  assert.equal(native.field.fdDictType, "numberDict");
  assert.equal(native.attribute.config.type, "numbertext");
  assert.deepEqual(native.controlProps.valueType, {
    formatType: "decimal",
    groupingUsed: false,
    precision
  });
  assert.deepEqual(native.controlProps.numberFormat, {
    formatType: "decimal",
    percentage: null,
    precision: String(precision),
    groupingUsed: false,
    symbol: null,
    unit: ""
  });
  assert.equal(native.controlProps.defaultValueType, "formula");
  assert.equal(native.controlProps.showCount, true);
  assert.equal(native.fontExtendData.precision, String(precision));
  assert.equal(native.fontExtendData.formatType, "decimal");
  assert.equal(native.fontExtendData.groupingUsed, false);
}

function mutateNativeNumber(template, fieldId, mutate) {
  const native = nativeNumber(template, fieldId);
  mutate(native);
  native.field.fdAttribute = JSON.stringify(native.attribute);
  native.field.fdFontExtendData = JSON.stringify(native.fontExtendData);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(native.config);
}

function assertPrecisionMismatch(readback, fieldId) {
  assert.equal(readback.ok, false);
  assert.equal(
    readback.diagnostics.some((item) =>
      item.code === "readback.form.prop_precision_mismatch" &&
      item.details?.fieldId === fieldId
    ),
    true,
    JSON.stringify(readback.diagnostics)
  );
}
