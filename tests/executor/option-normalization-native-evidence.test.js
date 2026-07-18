import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translateSourceFile } from "../../src/translator/index.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixture =
  "tests/fixtures/route-validation/option-normalization/route-option-normalization_SysFormTemplate.xml";

describe("option normalization native evidence", () => {
  it("projects unique options and the adjacent confirmation row to desktop and mobile", () => {
    const translated = translateSourceFile(fixture);
    const dsl = sampleTrustedDsl({ form: translated.form });
    delete dsl.workflow;
    const prepared = prepareSample(dsl);
    const config = xformConfig(prepared.update);
    const detail = config.dataModel.find((model) =>
      model.dynamicProps?.detailFieldName === "fd_items"
    );
    const location = detail.fdFields.find((field) => field.fdName === "fd_location");
    const locationAttribute = JSON.parse(location.fdAttribute);
    const main = config.dataModel.find((model) => model.fdType === "main");
    const hint = main.fdFields.find((field) => field.fdName === "confirm_hint");
    const confirm = main.fdFields.find((field) => field.fdName === "fd_confirm");
    const hintAttribute = JSON.parse(hint.fdAttribute);
    const confirmAttribute = JSON.parse(confirm.fdAttribute);
    const view = JSON.parse(config.viewModel[0].fdConfig);
    const desktopRows = view.view.render.desktop[0].children[0].children;
    const mobileRows = view.view.render.mobile[0].children[0].children;
    const confirmationRow = desktopRows.find((row) =>
      row.children[0].children.some((cell) =>
        cell.controlProps.migrationFieldId === "confirm_hint"
      )
    );

    assert.deepEqual(locationAttribute.config.controlProps.options, [
      { label: "North", value: "N" },
      { label: "South", value: "S" }
    ]);
    assert.deepEqual(locationAttribute.config.controlProps.desktop, {
      type: "@elem/xform-select"
    });
    assert.deepEqual(locationAttribute.config.controlProps.mobile, {
      type: "@elem/xform-m-select"
    });
    assert.equal(hintAttribute.config.type, "desc");
    assert.deepEqual(hintAttribute.config.labelProps, {
      compose: true,
      desktop: { hiddenLabel: true },
      title: "Confirm the related detail value",
      mobile: { hiddenLabel: true }
    });
    assert.deepEqual(confirmAttribute.config.controlProps.desktop, {
      type: "@elem/xform-radio"
    });
    assert.deepEqual(confirmAttribute.config.controlProps.mobile, {
      type: "@elem/xform-m-radio"
    });
    assert.equal(confirmAttribute.config.controlProps.required, true);
    assert.deepEqual(
      confirmationRow.children[0].children.map((cell) => ({
        fieldId: cell.controlProps.migrationFieldId,
        column: cell.controlProps.column,
        colSpan: cell.controlProps.colSpan
      })),
      [
        { fieldId: "confirm_hint", column: 1, colSpan: 1 },
        { fieldId: "fd_confirm", column: 2, colSpan: 1 }
      ]
    );
    assert.deepEqual(mobileRows, desktopRows);

    const readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.partitions.form, "verified");
  });

  it("detects a duplicate option value introduced in native persistence", () => {
    const translated = translateSourceFile(fixture);
    const dsl = sampleTrustedDsl({ form: translated.form });
    delete dsl.workflow;
    const prepared = prepareSample(dsl);
    const mutated = structuredClone(prepared.update);
    const config = xformConfig(mutated);
    const detail = config.dataModel.find((model) =>
      model.dynamicProps?.detailFieldName === "fd_items"
    );
    const location = detail.fdFields.find((field) => field.fdName === "fd_location");
    const attribute = JSON.parse(location.fdAttribute);
    attribute.config.controlProps.options.push({ label: "North", value: "N" });
    location.fdAttribute = JSON.stringify(attribute);
    mutated.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);

    const readback = prepared.verify(mutated);

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.form.prop_options_mismatch" &&
        item.details?.columnId === "fd_location"
      ),
      true
    );
  });
});
