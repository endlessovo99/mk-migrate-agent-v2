import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectTemplate } from "../helpers/persistence.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("native hard-hidden field shape", () => {
  it("matches the designer hidden-control contract and is appended to the view tail", () => {
    const field = {
      id: "fd_col_aj20ib",
      title: "隐藏控件1",
      type: "text",
      componentId: "xform-hidden",
      props: {},
      sourceProps: { hardHidden: true, designerType: "inputText" },
      sourceRef: "source.form.dataField.fd_col_aj20ib"
    };
    const dsl = sampleTrustedDsl({
      workflow: undefined,
      form: {
        fields: [
          {
            id: "fd_subject",
            title: "主题",
            type: "text",
            componentId: "xform-input",
            props: {},
            sourceProps: { designerType: "inputText" },
            sourceRef: "source.form.control.fd_subject"
          },
          field
        ],
        layout: {
          sourceGrid: { rows: [] },
          mkTree: [{
            id: "layout.row-0",
            componentId: "xform-flex-1-1-layout",
            props: { columns: 1 },
            sourceRef: "source.form.layout.row.row-0",
            children: [{
              id: "layout.row-0-cell-0",
              refType: "field",
              refIds: ["fd_subject"],
              sourceRef: "source.form.layout.cell.row-0-cell-0",
              column: 0,
              colspan: 1
            }]
          }, {
            id: "layout.row-1",
            componentId: "xform-flex-1-1-layout",
            props: { columns: 1 },
            sourceRef: field.sourceRef,
            children: [{
              id: "layout.row-1-cell-0",
              refType: "field",
              refIds: [field.id],
              sourceRef: field.sourceRef,
              column: 0,
              colspan: 1
            }]
          }]
        }
      }
    });

    const payload = projectTemplate(dsl);
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const main = config.dataModel.find((model) => model.fdType === "main");
    const native = main.fdFields.find((candidate) => candidate.fdName === field.id);
    const attribute = JSON.parse(native.fdAttribute);
    const controlProps = attribute.config.controlProps;

    assert.equal(native.fdType, "hidden");
    assert.equal(native.fdDataType, "varchar");
    assert.equal(native.fdDictType, "simpleDict");
    assert.equal(native.fdIsStored, true);
    assert.equal(native.fdDisplay, true);
    assert.deepEqual(JSON.parse(native.fdFontExtendData), {
      passValue: true,
      hidden: true,
      defaultValueType: "formula"
    });
    assert.equal(attribute.config.type, "hidden");
    assert.equal(controlProps.type, undefined);
    assert.equal(controlProps["$$allowCustomValue"], undefined);
    assert.equal(controlProps.controlType.value, "@elem/xform-input");
    assert.equal(controlProps.passValue, true);
    assert.equal(controlProps.hidden, true);
    assert.equal(controlProps.span, 12);
    assert.deepEqual(attribute.config.labelProps, {
      compose: true,
      desktop: { hiddenLabel: true },
      hidden: true,
      title: "隐藏控件1",
      mobile: { hiddenLabel: true },
      visible: false
    });

    const view = JSON.parse(config.viewModel[0].fdConfig);
    const desktop = view.view.render.desktop[0].children[0].children;
    const hiddenRow = desktop.at(-1);
    assert.equal(hiddenRow.children[0].children[0].children[0].key, field.id);
  });
});
