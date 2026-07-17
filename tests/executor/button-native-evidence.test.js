import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

describe("xform-button native persistence", () => {
  it("writes button-native typeCfg JavaScript and verifies it on readback", () => {
    const dsl = buttonDsl();
    const prepared = prepareSample(dsl);
    const config = xformConfig(prepared.update);
    const model = config.dataModel.find((item) => item.fdType === "main");
    const detailModel = config.dataModel.find((item) => item.fdType === "detail");
    const field = model.fdFields.find((item) => item.fdName === "fd_generate_parts");
    const attribute = JSON.parse(field.fdAttribute);
    const language = JSON.parse(config.lang);
    const scriptToken = attribute.config.controlProps.typeCfg.operInfo;

    assert.equal(field.fdType, "button");
    assert.equal(field.fdIsStored, false);
    assert.equal(attribute.config.controlProps.desktop.type, "@elem/xform-button");
    assert.equal(attribute.config.controlProps.mobile.type, "@elem/xform-m-button");
    assert.equal(attribute.config.controlProps.typeCfg.type, "js");
    assert.match(language[scriptToken].content.Cn, new RegExp(detailModel.fdTableName));
    assert.match(language[scriptToken].content.Cn, /mk-migrate:view-status=add,edit/);
    assert.equal(language[scriptToken].content.Cn.includes("${table:fd_detail}"), false);
    assert.deepEqual(config.auth[0].view[model.fdTableName].fields.fd_generate_parts, {
      visible: false,
      hide: true
    });
    assert.equal(prepared.verify(structuredClone(prepared.update)).ok, true);
  });

  it("rejects readback that loses the button-native JavaScript binding", () => {
    const prepared = prepareSample(buttonDsl());
    const readback = structuredClone(prepared.update);
    const config = xformConfig(readback);
    const model = config.dataModel.find((item) => item.fdType === "main");
    const field = model.fdFields.find((item) => item.fdName === "fd_generate_parts");
    const attribute = JSON.parse(field.fdAttribute);
    delete attribute.config.controlProps.typeCfg;
    field.fdAttribute = JSON.stringify(attribute);
    readback.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);

    const result = prepared.verify(readback);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) =>
      item.code === "readback.scripts.button_native_binding_missing"
    ), true);
  });

  it("rejects synchronized corruption of guarded controlAction and native button JavaScript", () => {
    const prepared = prepareSample(buttonDsl());
    const readback = structuredClone(prepared.update);
    const config = xformConfig(readback);
    const model = config.dataModel.find((item) => item.fdType === "main");
    const field = model.fdFields.find((item) => item.fdName === "fd_generate_parts");
    const attribute = JSON.parse(field.fdAttribute);
    const scriptToken = attribute.config.controlProps.typeCfg.operInfo;
    const language = JSON.parse(config.lang);
    const formAttr = JSON.parse(config.attribute.formAttr);
    const controlKey = `${model.fdTableName}.fd_generate_parts`;
    const corrupt = (source) => source.replace(/MKXFORM\.addRow\([^\n]+/, "console.log('corrupt')");
    formAttr.controlAction.control[controlKey].onClick[0].function = corrupt(
      formAttr.controlAction.control[controlKey].onClick[0].function
    );
    language[scriptToken].content.Cn = corrupt(language[scriptToken].content.Cn);
    config.attribute.formAttr = JSON.stringify(formAttr);
    config.lang = JSON.stringify(language);
    readback.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);

    const result = prepared.verify(readback);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) =>
      item.code === "readback.scripts.body_digest_mismatch"
    ), true);
  });
});

function buttonDsl() {
  const dsl = sampleTrustedDsl({ workflow: null });
  delete dsl.workflow;
  dsl.form.fields.push({
    id: "fd_generate_parts",
    title: "生成部件清单",
    type: "button",
    componentId: "xform-button",
    props: {},
    sourceProps: {},
    sourceRef: "source.form.jsp.fd_generate_parts",
    generated: false
  });
  dsl.form.fields.at(-1).sourceProps.displayGate = "xform:editShow";
  dsl.form.layout.mkTree.push({
    id: "layout.button",
    componentId: "xform-flex-1-1-layout",
    props: { columns: 1, sourceColumns: 1 },
    sourceRef: "source.form.jsp.fd_generate_parts",
    children: [{
      id: "layout.button.cell",
      refType: "field",
      refIds: ["fd_generate_parts"],
      column: 0,
      colspan: 1
    }]
  });
  dsl.scripts = {
    source: "sysform-jsp",
    actions: [{
      id: "generate-parts",
      name: "onClick",
      event: "onClick",
      scope: "control",
      controlId: "fd_generate_parts",
      translationStatus: "translated",
      runWhen: { viewStatusIn: ["add", "edit"] },
      function: "function onClick() {\n  MKXFORM.addRow('${table:fd_detail}', {})\n}"
    }]
  };
  return dsl;
}
