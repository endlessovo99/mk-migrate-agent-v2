import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExpectedInvariants } from "../../src/executor/persistence/expected.js";
import { sampleEnvelope } from "../helpers/persistence.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("calculation displayExpression expected invariants", () => {
  it("derives expected formula display text from field titles, not source expression_name labels", () => {
    const dsl = sampleTrustedDsl({
      form: {
        fields: [
          { id: "fd_left", title: "本次预投内部人工成本+项目费用（元）：", type: "number", componentId: "xform-input-number", props: {} },
          { id: "fd_right", title: "本次预投外采（含外包人天）成本（元）：", type: "number", componentId: "xform-input-number", props: {} },
          {
            id: "fd_total",
            title: "累计预投成本（元）：",
            type: "number",
            componentId: "xform-calculate",
            props: {
              calculation: {
                kind: "formula",
                expression: "$fd_left$ + $fd_right$",
                displayExpression: "$本次内部人工成本及项目费用$ + $本次预投外采成本$",
                fieldIds: ["fd_left", "fd_right"]
              }
            }
          }
        ]
      }
    });

    const expected = buildExpectedInvariants(dsl, sampleEnvelope());
    assert.equal(expected.ok, true, JSON.stringify(expected.diagnostics));
    assert.deepEqual(
      expected.expected.form.fields.find((field) => field.id === "fd_total").props.calculation,
      {
        kind: "formula",
        expression: "$fd_left$ + $fd_right$",
        displayExpression: "$本次预投内部人工成本+项目费用（元）：$ + $本次预投外采（含外包人天）成本（元）：$",
        fieldIds: ["fd_left", "fd_right"]
      }
    );
  });
});
