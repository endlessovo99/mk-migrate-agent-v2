import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("static form-property script coverage validation", () => {
  it("accepts an omitted action audited by an already-required field prop", () => {
    const result = validateMigrationDsl(dslWithCoverage([
      { fieldId: "fd_subject", prop: "required", value: true }
    ]), { mode: "execute" });

    assert.equal(result.ok, true);
  });

  it("rejects static coverage that is malformed or not satisfied by the form", () => {
    const optional = validateMigrationDsl(dslWithCoverage([
      { fieldId: "fd_amount", prop: "required", value: true }
    ]), { mode: "execute" });
    const unsupported = validateMigrationDsl(dslWithCoverage([
      { fieldId: "fd_subject", prop: "visible", value: true }
    ]), { mode: "execute" });
    const missingEvidence = validateMigrationDsl(dslWithCoverage([]), { mode: "execute" });
    const gated = dslWithCoverage([
      { fieldId: "fd_subject", prop: "required", value: true }
    ]);
    gated.scripts.actions[0].runWhen = { viewStatusIn: ["view"] };
    const gatedResult = validateMigrationDsl(gated, { mode: "execute" });

    assert.equal(optional.diagnostics.some((item) => item.code === "dsl.scripts.static_prop_not_satisfied"), true);
    assert.equal(unsupported.diagnostics.some((item) => item.code === "dsl.scripts.static_prop_unsupported"), true);
    assert.equal(missingEvidence.diagnostics.some((item) => item.code === "dsl.scripts.omitted_coverage_incomplete"), true);
    assert.equal(gatedResult.diagnostics.some((item) => item.code === "dsl.scripts.gated_omission_forbidden"), true);
  });
});

function dslWithCoverage(staticProps) {
  return sampleTrustedDsl({
    workflow: undefined,
    scripts: {
      actions: [{
        id: "required-only.script.1.event.1",
        name: "onLoad",
        event: "onLoad",
        scope: "global",
        function: "",
        translationStatus: "omitted",
        sourceRefs: ["source.form.jsp.required-only.script.1"],
        coverage: {
          status: "covered",
          nativeRules: [],
          staticProps,
          residuals: []
        },
        functionMappings: [{
          source: "jQuery validate=required onLoad",
          target: "form.fields[].props.required",
          basis: "static-form-prop",
          reviewRequired: false
        }]
      }]
    }
  });
}
