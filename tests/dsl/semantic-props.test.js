import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkExecute } from "../../src/dsl/checks.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("semantic DSL props", () => {
  it("accepts the cataloged xform-number unit prop", () => {
    const dsl = sampleTrustedDsl();
    const amount = dsl.form.fields.find((field) => field.id === "fd_amount");
    amount.type = "number";
    amount.componentId = "xform-number";
    amount.props.unit = "元";

    const result = checkExecute(dsl);

    assert.equal(result.diagnostics.some((item) =>
      item.path === "/form/fields/1/props/unit"
    ), false);
  });

  it("rejects a non-string workflow node help value", () => {
    const dsl = sampleTrustedDsl();
    dsl.workflow.nodes[0].help = 42;

    const result = checkExecute(dsl);

    assert.equal(result.diagnostics.some((item) =>
      item.code === "dsl.workflow.node.help_type" &&
      item.path === "/workflow/nodes/0/help"
    ), true);
  });
});
