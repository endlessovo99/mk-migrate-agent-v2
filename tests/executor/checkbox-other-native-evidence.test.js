import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

// Explicit target DSL contract. No source textbox/caption is inferred to be a
// native Other widget, and the stored-only field is independent metadata.
function nativeOtherDsl() {
  const dsl = sampleTrustedDsl(); delete dsl.workflow;
  const radio = dsl.form.fields.find(field => field.id === "fd_amount");
  Object.assign(radio, { title: "Native radio", type: "radio", componentId: "xform-radio", sourceProps: {}, props: {
    options: [{ label: "Normal", value: "normal" }, { label: "Other", value: "other_", type: "other", isRequired: true }]
  } });
  const table = dsl.form.fields.find(field => field.id === "fd_detail");
  table.columns = [
    { id: "fd_node_auth", title: "Native checkbox", type: "checkbox", componentId: "xform-checkbox", props: {
      options: [{ label: "Normal", value: "1" }, { label: "Other", value: "other_", type: "other", isRequired: true }]
    }, sourceProps: {}, sourceRef: "explicit-native.contract.checkbox" },
    { id: "fd_node_note", title: "Note", type: "text", componentId: "xform-input", props: {}, sourceProps: {}, sourceRef: "explicit-native.contract.note" },
    { id: "fd_stored_only", title: "Stored metadata", type: "text", componentId: "xform-input", dataOnly: true, props: {}, sourceProps: {}, sourceRef: "explicit-native.contract.stored" }
  ];
  return dsl;
}

describe("explicit native Other option evidence", () => {
  it("writes explicitly requested native radio/checkbox Other and preserves independent stored metadata", () => {
    const prepared = prepareSample(nativeOtherDsl()), config = xformConfig(prepared.update);
    const detail = config.dataModel.find(model => model.dynamicProps?.detailFieldName === "fd_detail");
    const auth = detail.fdFields.find(field => field.fdName === "fd_node_auth");
    const stored = detail.fdFields.find(field => field.fdName === "fd_stored_only");
    const props = JSON.parse(auth.fdAttribute).config.controlProps;
    assert.equal(auth.fdType, "checkbox");
    assert.equal(props.desktop.type, "@elem/xform-checkbox");
    assert.equal(props.mobile.type, "@elem/xform-m-checkbox");
    assert.equal(props.multi, true);
    const nativeOther = { label: "Other", value: "other_", type: "other", colorSwitch: false, isRequired: true };
    assert.deepEqual(props.options.at(-1), nativeOther);
    const radio = config.dataModel.find(model => model.fdType === "main").fdFields.find(field => field.fdName === "fd_amount");
    assert.deepEqual(JSON.parse(radio.fdAttribute).config.controlProps.options.at(-1), nativeOther);
    assert.equal(stored.fdDisplay, false);
    assert.equal(stored.fdIsStored, true);
    const view = JSON.parse(config.viewModel[0].fdConfig), detailRef = findNode(view, node => node.key === detail.fdTableName);
    assert.deepEqual(detailRef.children.map(child => child.key), ["fd_node_auth", "fd_node_note"]);
    const readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.partitions.form, "verified");
  });

  for (const [name, id, change] of [
    ["missing checkbox Other option", "fd_node_auth", props => { props.options = props.options.filter(option => option.value !== "other_"); }],
    ["missing checkbox Other type", "fd_node_auth", props => { delete props.options.at(-1).type; }],
    ["lost checkbox Other requirement", "fd_node_auth", props => { props.options.at(-1).isRequired = false; }],
    ["lost radio Other requirement", "fd_amount", props => { props.options.at(-1).isRequired = false; }]
  ]) it("rejects native persistence loss: " + name, () => {
    const prepared = prepareSample(nativeOtherDsl()), mutated = structuredClone(prepared.update), config = xformConfig(mutated);
    const native = config.dataModel.flatMap(model => model.fdFields || []).find(field => field.fdName === id), attribute = JSON.parse(native.fdAttribute);
    const before = structuredClone(attribute.config.controlProps); change(attribute.config.controlProps);
    assert.notDeepEqual(attribute.config.controlProps, before, "The native counterexample must actually mutate the requested contract");
    native.fdAttribute = JSON.stringify(attribute); mutated.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    const readback = prepared.verify(mutated);
    assert.equal(readback.ok, false);
    assert.ok(readback.diagnostics.some(item => item.code === "readback.form.prop_options_mismatch" &&
      (item.details?.columnId === id || item.details?.fieldId === id)));
  });
});
function findNode(value, predicate) {
  if (!value || typeof value !== "object") return undefined;
  if (predicate(value)) return value;
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    const found = findNode(entry, predicate); if (found) return found;
  }
  return undefined;
}
