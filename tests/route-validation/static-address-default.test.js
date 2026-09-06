import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/static-address-default/route-static-address-default_SysFormTemplate.xml";
const expectedDefault = {
  kind: "staticOrg",
  id: "route-fixed-org",
  name: "Route Fixed Organization"
};

describe("static address default Route case", () => {
  it("maps matching designer selection and OtherFunction.getModel evidence", () => {
    const { source, dsl } = stages();
    const sourceField = source.form.controls.find((field) => field.id === "fd_company");
    const field = dsl.form.fields.find((candidate) => candidate.id === "fd_company");

    assert.equal(
      sourceField.sourceProps.metadataAttributes.defaultValue,
      'OtherFunction.getModel("route-fixed-org", "com.landray.kmss.sys.organization.model.SysOrgElement", null)'
    );
    assert.deepEqual(field.props.defaultValue, expectedDefault);
  });

  it("fails closed when the selected organization conflicts with the metadata formula", () => {
    const source = cleanSourceFile(fixture);
    const sourceField = source.form.controls.find((field) => field.id === "fd_company");
    sourceField.sourceProps.metadataAttributes.defaultValue =
      sourceField.sourceProps.metadataAttributes.defaultValue.replace("route-fixed-org", "different-org");

    const dsl = draftSourceDraft(source);
    assert.equal(
      dsl.form.fields.find((field) => field.id === "fd_company").props.defaultValue,
      undefined
    );
  });

  it("accepts staticOrg only as a complete address default", () => {
    const { dsl } = stages();
    const missingName = structuredClone(dsl);
    delete missingName.form.fields.find((field) => field.id === "fd_company").props.defaultValue.name;
    assert.equal(checkDraft(missingName).ok, false);

    const wrongComponent = structuredClone(dsl);
    const field = wrongComponent.form.fields.find((candidate) => candidate.id === "fd_company");
    field.componentId = "xform-input";
    assert.equal(checkDraft(wrongComponent).ok, false);
  });

  it("writes and verifies the native fixed-address contract captured from NewOA", () => {
    const { dsl } = stages();
    const prepared = prepareSample(dsl);
    const config = xformConfig(prepared.update);
    const nativeField = config.dataModel[0].fdFields.find((field) => field.fdName === "fd_company");
    const controlProps = JSON.parse(nativeField.fdAttribute).config.controlProps;
    const font = JSON.parse(nativeField.fdFontExtendData);

    assert.deepEqual({
      defaultValue: controlProps.defaultValue,
      org: controlProps.org,
      multi: controlProps.multi,
      preSelectType: controlProps.preSelectType,
      showOrgType: controlProps.showOrgType,
      maxLength: controlProps.maxLength,
      allowCustomValue: controlProps["$$allowCustomValue"],
      type: controlProps.type,
      range: controlProps.range,
      relation: controlProps.relation
    }, {
      defaultValue: { fdId: "route-fixed-org", fdName: "Route Fixed Organization" },
      org: { orgTypeArr: ["1", "2"], defaultValueType: "fixed" },
      multi: false,
      preSelectType: "fixed",
      showOrgType: 0,
      maxLength: 200,
      allowCustomValue: true,
      type: "@elem/xform-address",
      range: "all",
      relation: []
    });
    assert.deepEqual(font, {
      orgTypeArr: ["1", "2"],
      defaultValueType: "fixed",
      passValue: false,
      orgAvailable: false,
      showAvatar: false,
      trace: false,
      range: "all",
      multi: false,
      relation: [],
      defaultValue: { fdId: "route-fixed-org", fdName: "Route Fixed Organization" }
    });

    const verified = prepared.verify(prepared.update);
    assert.equal(verified.ok, true, JSON.stringify(verified.diagnostics));
    assert.deepEqual(
      verified.form.fields.find((field) => field.id === "fd_company").defaultValue,
      expectedDefault
    );

    const broken = structuredClone(prepared.update);
    const brokenConfig = xformConfig(broken);
    const brokenField = brokenConfig.dataModel[0].fdFields.find((field) => field.fdName === "fd_company");
    const brokenAttribute = JSON.parse(brokenField.fdAttribute);
    delete brokenAttribute.config.controlProps.defaultValue;
    brokenField.fdAttribute = JSON.stringify(brokenAttribute);
    broken.mechanisms["sys-xform"].fdConfig = JSON.stringify(brokenConfig);
    const mismatch = prepared.verify(broken);
    assert.equal(mismatch.ok, false);
    assert.equal(
      mismatch.diagnostics.some((diagnostic) => diagnostic.code.includes("defaultValue")),
      true
    );

    const brokenFont = structuredClone(prepared.update);
    const brokenFontConfig = xformConfig(brokenFont);
    const brokenFontField = brokenFontConfig.dataModel[0].fdFields
      .find((field) => field.fdName === "fd_company");
    const mutatedFont = JSON.parse(brokenFontField.fdFontExtendData);
    delete mutatedFont.defaultValue;
    brokenFontField.fdFontExtendData = JSON.stringify(mutatedFont);
    brokenFont.mechanisms["sys-xform"].fdConfig = JSON.stringify(brokenFontConfig);
    const fontMismatch = prepared.verify(brokenFont);
    assert.equal(fontMismatch.ok, false);
    assert.equal(
      fontMismatch.diagnostics.some((diagnostic) => (
        diagnostic.code === "readback.form.prop_defaultValue_mismatch"
      )),
      true
    );
  });

  it("binds the static default to source provenance at trust time", () => {
    const { source, dsl } = stages();
    const trusted = createTrustedMigrationDsl(source, dsl, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-09-05T00:00:00.000Z"
    });
    trusted.form.fields.find((field) => field.id === "fd_company")
      .props.defaultValue.name = "Tampered Organization";

    const check = checkTrust(source, trusted);
    assert.equal(check.ok, false);
    assert.equal(
      check.diagnostics.some((diagnostic) => (
        diagnostic.code === "trust.form.static_address_default_source_mismatch"
      )),
      true
    );
  });

  it("resolves the target organization before writing and verifies full Route readback", async () => {
    const result = await runRouteCase("static-address-default-success");
    const field = result.execution.readback.form.fields.find((candidate) => candidate.id === "fd_company");

    assert.equal(result.execution.readback.partitions.form, "verified");
    assert.deepEqual(field.defaultValue, expectedDefault);
    assert.deepEqual(result.transcript[1], {
      operation: "get-element-info",
      targets: ["route-fixed-org"]
    });
    assert.deepEqual(
      result.transcript.map((entry) => entry.operation),
      [
        "login",
        "get-element-info",
        "init",
        "generate-table-name",
        "load-parent-category",
        "add",
        "get-before-update",
        "update",
        "get-readback",
        "add-transfer-record"
      ]
    );
  });
});

function stages() {
  const source = cleanSourceFile(fixture);
  return { source, dsl: draftSourceDraft(source) };
}
