import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture =
  "tests/fixtures/route-validation/named-window-load-helper/named-window-load-helper_SysFormTemplate.xml";

describe("named window-load helper Route case", () => {
  it("proves the helper's exact source field branch and preserves helper evidence", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const action = dsl.scripts.actions.find((candidate) =>
      candidate.event === "onLoad" &&
      candidate.sourceRefs.includes("source.form.jsp.jsp_named_load.script.1")
    );

    assert.ok(action);
    assert.equal(action.translationStatus, "needs_review");
    assert.deepEqual(action.branchProvenance, {
      version: 3,
      event: "onLoad",
      sourceRef: "source.form.jsp.jsp_named_load.script.1",
      status: "proven",
      conditions: [{
        kind: "eq",
        value: "1",
        origin: "field:fd_company_type",
        transforms: [],
        predicate: "loose-equality"
      }]
    });
    assert.match(action.function, /function changeCompany\s*\(\s*\)/);
    assert.match(action.function, /var leftId = "fd_company_type"/);
    assert.match(action.function, /var rightId = "fd_joint_company"/);
    assert.match(action.function, /GetXFormFieldById\(leftId\)/);
    assert.match(action.function, /radioValue\s*==\s*"1"/);
  });
});
