import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

const placeholder = "简述成立时间、注册资金、人员规模、主营业务等";

describe("Placeholder static-property Route case", () => {
  it("promotes a placeholder-only onLoad through trusted DSL and fake readback", async () => {
    const result = await runRouteCase("placeholder-static-success");
    const field = result.dsl.form.fields.find((candidate) =>
      candidate.id === "fd_subject"
    );
    const action = result.dsl.scripts.actions.find((candidate) =>
      candidate.coverage?.staticProps?.some((entry) =>
        entry.fieldId === "fd_subject" &&
        entry.prop === "placeholder"
      )
    );
    const observed = result.execution.readback.form.fields.find((candidate) =>
      candidate.id === "fd_subject"
    );

    assert.equal(field.props.placeholder, placeholder);
    assert.equal(action.translationStatus, "omitted");
    assert.equal(action.function, "");
    assert.equal(result.dryRun.ok, true);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.readback.ok, true);
    assert.equal(observed.placeholder, placeholder);
  });
});
