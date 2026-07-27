import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fieldId = "fd_col_4qkbo3";
const content = "请点击查看采购需求清单模板";
const link =
  "http://kms.shanghai-electric.com/kms/multidoc/kms_multidoc_knowledge/" +
  "kmsMultidocKnowledge.do?method=view&fdId=18e5f7972ce8d1c7e96e8354bc69fea5";

describe("linked xform-description native persistence", () => {
  it("matches the fd_col_4qkbo3 scalar-link contract", () => {
    const prepared = prepareSample(linkedDescriptionDsl());
    const config = xformConfig(prepared.update);
    const model = config.dataModel.find((item) => item.fdType === "main");
    const field = model.fdFields.find((item) => item.fdName === fieldId);
    const attribute = JSON.parse(field.fdAttribute);
    const controlProps = attribute.config.controlProps;
    const lang = JSON.parse(config.lang);
    const view = JSON.parse(config.viewModel[0].fdConfig);

    assert.equal(field.fdType, "desc");
    assert.equal(field.fdDataType, "varchar");
    assert.equal(field.fdIsStored, false);
    assert.equal(field.fdLength, 0);
    assert.equal(controlProps.desktop.type, "@elem/xform-description");
    assert.equal(controlProps.mobile.type, "@elem/xform-m-description");
    assert.equal(controlProps.hasLink, true);
    assert.equal(controlProps.link, link);
    assert.equal(controlProps.defaultTextValue, field.fdLabelLangKey);
    assert.equal(controlProps.title, field.fdLabelLangKey);
    assert.equal(Object.hasOwn(controlProps, "content"), false);
    assert.equal(attribute.config.label, field.fdLabelLangKey);
    assert.equal(attribute.config.labelProps.title, field.fdLabelLangKey);
    assert.deepEqual(lang[field.fdLabelLangKey], {
      prop: "defaultTextValue",
      name: fieldId,
      type: "input",
      content: { Cn: content, default: content }
    });
    assert.deepEqual(view.controlStyle[fieldId], {
      desktop: { layout: "vertical" }
    });

    const readback = prepared.verify(structuredClone(prepared.update));
    assert.equal(readback.ok, true);
    assert.deepEqual(
      readback.form.fields.find((item) => item.id === fieldId),
      {
        id: fieldId,
        title: content,
        type: "desc",
        component: "xform-description",
        required: false,
        content,
        hasLink: true,
        link,
        style: undefined,
        dataOnly: false,
        columns: []
      }
    );
  });
});

function linkedDescriptionDsl() {
  const dsl = sampleTrustedDsl();
  delete dsl.workflow;
  dsl.form.fields.push({
    id: fieldId,
    title: content,
    type: "description",
    componentId: "xform-description",
    props: { content, hasLink: true, link },
    sourceProps: { designerType: "linkLabel" },
    sourceRef: `source.form.control.${fieldId}`
  });
  dsl.form.layout.mkTree.unshift({
    id: "layout.row-linked-description",
    componentId: "xform-flex-1-1-layout",
    props: { columns: 1, sourceColumns: 1 },
    sourceRef: "source.form.layout.row.linked-description",
    children: [{
      id: "layout.row-linked-description-cell-0",
      refType: "field",
      refIds: [fieldId],
      sourceRef: "source.form.layout.cell.linked-description-cell-0",
      column: 0,
      colspan: 1
    }]
  });
  return dsl;
}
