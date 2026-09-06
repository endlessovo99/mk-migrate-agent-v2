import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translateSourceFile } from "../../src/translator/index.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixture =
  "tests/fixtures/route-validation/checkbox-other-option/route-checkbox-other-option_SysFormTemplate.xml";

describe("checkbox other-option native evidence", () => {
  it("writes a native checkbox other option and keeps the companion stored but hidden", () => {
    const translated = translateSourceFile(fixture);
    const dsl = sampleTrustedDsl({ form: translated.form });
    delete dsl.workflow;
    const prepared = prepareSample(dsl);
    const config = xformConfig(prepared.update);
    const detail = config.dataModel.find((model) =>
      model.dynamicProps?.detailFieldName === "fd_nodes"
    );
    const auth = detail.fdFields.find((field) => field.fdName === "fd_node_auth");
    const other = detail.fdFields.find((field) => field.fdName === "fd_node_auth_other");
    const authAttribute = JSON.parse(auth.fdAttribute);
    const view = JSON.parse(config.viewModel[0].fdConfig);
    const detailRef = findNode(view, (node) => node.key === detail.fdTableName);

    assert.equal(auth.fdType, "checkbox");
    assert.equal(authAttribute.config.controlProps.desktop.type, "@elem/xform-checkbox");
    assert.equal(authAttribute.config.controlProps.multi, true);
    assert.deepEqual(authAttribute.config.controlProps.options.at(-1), {
      label: "其他",
      value: "other_",
      type: "other",
      colorSwitch: false,
      isRequired: true
    });
    assert.equal(other.fdDisplay, false);
    assert.deepEqual(
      detailRef.children.map((child) => child.key),
      ["fd_node_auth", "fd_node_note"]
    );

    const readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.partitions.form, "verified");
  });

  it("detects loss of the required other option in native persistence", () => {
    const translated = translateSourceFile(fixture);
    const dsl = sampleTrustedDsl({ form: translated.form });
    delete dsl.workflow;
    const prepared = prepareSample(dsl);
    const mutated = structuredClone(prepared.update);
    const config = xformConfig(mutated);
    const detail = config.dataModel.find((model) =>
      model.dynamicProps?.detailFieldName === "fd_nodes"
    );
    const auth = detail.fdFields.find((field) => field.fdName === "fd_node_auth");
    const attribute = JSON.parse(auth.fdAttribute);
    attribute.config.controlProps.options = attribute.config.controlProps.options.filter(
      (option) => option.value !== "other_"
    );
    auth.fdAttribute = JSON.stringify(attribute);
    mutated.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);

    const readback = prepared.verify(mutated);
    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.form.prop_options_mismatch" &&
        item.details?.columnId === "fd_node_auth"
      ),
      true
    );
  });
});

function findNode(value, predicate) {
  if (!value || typeof value !== "object") return undefined;
  if (predicate(value)) return value;
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    const found = findNode(entry, predicate);
    if (found) return found;
  }
  return undefined;
}
