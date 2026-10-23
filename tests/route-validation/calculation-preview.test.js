import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const preview = load("../fixtures/route-validation/calculation-migration/official-preview-contract.json");
const native = load("../fixtures/route-validation/native-calculated-import/native-contract.json");
const digest = (text) => createHash("sha256").update(text).digest("hex");
assert.equal(digest(preview.callback), preview.callbackSha256);
assert.equal(`sha256:${digest(native.statistics.re.text)}`, native.statistics.re.sha256);
const bigScope = {};
vm.runInNewContext(`var ${native.BigFixture.text};Big=Ni;`, bigScope);
const toFixed = vm.runInNewContext(`(${native.toFixed.text.slice("t.toFixed=".length)})`);

function preparedConfig(dsl) {
  return xformConfig(prepareSample(dsl).update);
}
function sourceDsl() {
  const draft = draftSourceDraft(cleanSourceFile(
    "tests/fixtures/route-validation/calculation-migration/route-calculation-migration_SysFormTemplate.xml"
  ));
  return sampleTrustedDsl({ form: draft.form, formRules: draft.formRules, scripts: draft.scripts, workflow: null });
}
function officialPreview(config) {
  let projected;
  vm.runInNewContext(`(${preview.callback})`, { D: value => { projected = value; }, JSON })({
    data: { data: { fdConfig: JSON.stringify(config) } }
  });
  // Exercise the observed native fallback, which does not carry attribute/formAttr.
  assert.equal(projected.formAttr, undefined);
  assert.equal(projected.attribute, undefined);
  return projected;
}
function sumControl(config, name) {
  const main = config.dataModel.find(model => model.fdType === "main");
  return JSON.parse(main.fdFields.find(field => field.fdName === name).fdAttribute).config;
}
function nativeSum(control, rows, expectedPath) {
  let result;
  const props = control.controlProps;
  const run = vm.runInNewContext(`(${native.statistics.re.text})`, {
    m: props.statisticMode, W: props.statisticData, N: "main", s: props.valueType,
    t: { Big: bigScope.Big, toFixed, getValueByName(_form, path) {
      assert.equal(path, expectedPath);
      return rows;
    } },
    ee: vm.runInNewContext(`(${native.statistics.ee.text})`),
    k: {}, E: (value, count) => value.slice(0, count), y: value => [...value],
    b: { current: {} }, e: {}, te: (_name, value) => value,
    Y: { current: { value: undefined } }, z: value => { result = value; },
    f: undefined, R: {}, console, i: props.id, w: props.$$tableName, G: { current: 0 }
  });
  run();
  return result;
}

test("XML calculation route retains native SUM behavior through the official-preview fallback", () => {
  const config = officialPreview(preparedConfig(sourceDsl()));
  const sum = sumControl(config, "fd_detail_sum");
  const detail = config.dataModel.find(model => model.dynamicProps?.detailFieldName === "fd_lines");
  const path = `${detail.fdTableName}.fd_line_total`;
  // Known row results: 100 x 1; a later price edit; multiple rows; deletion; empty table.
  for (const [values, expected] of [[[100], 100], [[80], 80], [[100, 23.45], 123.45], [[23.45], 23.45], [[], 0]]) {
    assert.equal(nativeSum(sum, values.map(fd_line_total => ({ fd_line_total })), path), expected);
  }
});

test("full runtime hydration agrees with preview and still clears a mismatching compute rule", () => {
  const config = preparedConfig(sourceDsl());
  const control = sumControl(config, "fd_detail_sum");
  const formRule = JSON.parse(config.attribute.formAttr).formRule;
  const scope = { ta: formRule };
  scope.tk = vm.runInNewContext(`(${native.hydration.tk.text})`, scope);
  scope.tk(control);
  const detail = config.dataModel.find(model => model.dynamicProps?.detailFieldName === "fd_lines");
  assert.equal(nativeSum(control, [{ fd_line_total: 100 }], `${detail.fdTableName}.fd_line_total`), 100);
  for (const rule of formRule.compute) for (const item of rule.choices.items) {
    if (item.fieldName === "fd_detail_sum") item.fieldKey = "wrong-control";
  }
  scope.tk(control);
  assert.equal(control.controlProps.statisticData, undefined);
});

test("SUM target projection binds by control identity when a detail column shares its field name", () => {
  const config = preparedConfig(sampleTrustedDsl({ form: { fields: [
    { id: "lines", title: "明细", type: "detailTable", columns: [
      { id: "total", title: "行金额", type: "number", componentId: "xform-input-number", props: { precision: 2 } }
    ] },
    { id: "total", title: "主表合计", type: "number", componentId: "xform-calculate", props: {
      precision: 2, calculation: { kind: "aggregate", operation: "sum", tableId: "lines", fieldId: "total" }
    } }
  ] }, workflow: null }));
  const main = sumControl(config, "total");
  const detail = config.dataModel.find(model => model.fdType === "detail");
  assert.equal(nativeSum(main, [{ total: 100 }], `${detail.fdTableName}.total`), 100);
  const column = detail.fdFields.find(field => field.fdName === "total");
  assert.equal(JSON.parse(column.fdAttribute).config.controlProps.statisticData, undefined);
});
