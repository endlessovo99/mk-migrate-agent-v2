import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

describe("xform-hyperlinks native persistence", () => {
  it("writes and verifies the native hyperlinks/clob/HyperLinkDict contract", () => {
    const prepared = prepareSample(hyperlinksDsl());
    const config = xformConfig(prepared.update);
    const model = config.dataModel.find((item) => item.fdType === "main");
    const field = model.fdFields.find((item) => item.fdName === "invoiceLink");
    const attribute = JSON.parse(field.fdAttribute);
    const controlProps = attribute.config.controlProps;

    assert.equal(field.fdType, "hyperlinks");
    assert.equal(field.fdDataType, "clob");
    assert.equal(field.fdDictType, "HyperLinkDict");
    assert.equal(field.fdIsStored, true);
    assert.equal(Object.hasOwn(field, "fdLength"), false);
    assert.equal(controlProps.desktop.type, "@elem/xform-hyperlinks");
    assert.equal(controlProps.mobile.type, "@elem/xform-m-hyperlinks");
    assert.equal(controlProps.largestSet, 1);
    assert.equal(controlProps.editable, false);
    assert.equal(controlProps.defaultValueType, "fixed");
    assert.equal(prepared.verify(structuredClone(prepared.update)).ok, true);
  });

  it("rejects readback that changes hyperlink editability", () => {
    const prepared = prepareSample(hyperlinksDsl());
    const readback = structuredClone(prepared.update);
    const config = xformConfig(readback);
    const model = config.dataModel.find((item) => item.fdType === "main");
    const field = model.fdFields.find((item) => item.fdName === "invoiceLink");
    const attribute = JSON.parse(field.fdAttribute);
    attribute.config.controlProps.editable = true;
    field.fdAttribute = JSON.stringify(attribute);
    readback.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);

    const result = prepared.verify(readback);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((diagnostic) => (
      diagnostic.code === "readback.form.prop_editable_mismatch"
    )), true);
  });
});

function hyperlinksDsl() {
  const dsl = sampleTrustedDsl({ workflow: null });
  delete dsl.workflow;
  dsl.form.fields.push({
    id: "invoiceLink",
    title: "查看发票",
    type: "hyperlinks",
    componentId: "xform-hyperlinks",
    props: { largestSet: 1, editable: false },
    sourceProps: { dynamicHyperlinkProjection: { urlPolicy: "http-or-https" } },
    sourceRef: "source.form.jsp.invoice-link",
    generated: true,
    reason: "Project validated invoice URLs into a native link control."
  });
  dsl.form.layout.mkTree.push({
    id: "layout.invoice-link",
    componentId: "xform-flex-1-1-layout",
    props: { columns: 1, sourceColumns: 1 },
    sourceRef: "source.form.jsp.invoice-link",
    children: [{
      id: "layout.invoice-link.cell",
      refType: "field",
      refIds: ["invoiceLink"],
      sourceRef: "source.form.jsp.invoice-link",
      column: 0,
      colspan: 1
    }]
  });
  return dsl;
}
