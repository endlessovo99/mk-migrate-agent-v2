import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture =
  "tests/fixtures/route-validation/named-window-load-helper/named-window-load-helper_SysFormTemplate.xml";
const noLoadFixture =
  "tests/fixtures/route-validation/named-window-load-helper/named-value-change-helper-without-load_SysFormTemplate.xml";

describe("named window-load helper Route case", () => {
  it("proves the helper branch for both load and stable-alias value-change bindings", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const loadAction = dsl.scripts.actions.find((candidate) =>
      candidate.event === "onLoad" &&
      candidate.sourceRefs.includes("source.form.jsp.jsp_named_load.script.1")
    );
    const changeAction = dsl.scripts.actions.find((candidate) =>
      candidate.event === "onChange" &&
      candidate.controlId === "fd_company_type" &&
      candidate.sourceRefs.includes("source.form.jsp.jsp_named_load.script.1")
    );

    assert.ok(loadAction);
    assert.equal(loadAction.translationStatus, "needs_review");
    assert.deepEqual(loadAction.branchProvenance, {
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
    assert.match(loadAction.function, /function changeCompany\s*\(\s*\)/);
    assert.match(loadAction.function, /var leftId = "fd_company_type"/);
    assert.match(loadAction.function, /var rightId = "fd_joint_company"/);
    assert.match(loadAction.function, /GetXFormFieldById\(leftId\)/);
    assert.match(loadAction.function, /radioValue\s*==\s*"1"/);

    assert.ok(changeAction);
    assert.equal(changeAction.translationStatus, "needs_review");
    assert.match(
      changeAction.sourceActionKey,
      /^source\.form\.jsp\.jsp_named_load\.script\.1#onChange@\d+$/
    );
    assert.deepEqual(changeAction.branchProvenance, {
      version: 3,
      event: "onChange",
      sourceRef: "source.form.jsp.jsp_named_load.script.1",
      sourceActionKey: changeAction.sourceActionKey,
      status: "proven",
      conditions: [{
        kind: "eq",
        value: "1",
        origin: "event:value",
        transforms: [],
        predicate: "loose-equality"
      }]
    });
    assert.match(changeAction.function, /function changeCompany\s*\(\s*\)/);
    assert.match(changeAction.function, /AttachXFormValueChangeEventById\(leftId,\s*changeCompany\)/);

    const noLoadDsl = draftSourceDraft(cleanSourceFile(noLoadFixture));
    assert.equal(
      noLoadDsl.scripts.actions.some((candidate) =>
        candidate.event === "onChange" &&
        candidate.controlId === "fd_company_type"
      ),
      false
    );
  });
});
