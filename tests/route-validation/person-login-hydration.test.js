import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture =
  "tests/fixtures/route-validation/person-login-hydration/route-person-login-hydration_SysFormTemplate.xml";

describe("person login hydration after a matching window load prefix", () => {
  it("maps the applicant address change and load lookup onto the login-name field", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const actions = (draft.scripts?.actions || []).filter((action) =>
      action.semanticHints?.personPropertyHydration
    );
    const onChange = actions.find((action) => action.event === "onChange");
    const onLoad = actions.find((action) => action.event === "onLoad");
    assert.ok(onChange, JSON.stringify(draft.scripts || {}));
    assert.ok(onLoad, JSON.stringify((draft.scripts || {}).actions || []));
    const writes = [];
    const loadWrites = [];
    const onChangeFn = new Function(
      "MKXFORM",
      `${onChange.function}; return onChange;`
    )({
      callOrg(_request, callback) {
        callback(null, { fdLoginName: "101-EKP-USER" });
      },
      setValue(id, value) {
        writes.push([id, value]);
      }
    });
    const onLoadFn = new Function(
      "MKXFORM",
      `${onLoad.function}; return onLoad;`
    )({
      getValue(fieldId) {
        return fieldId === "fd_approver" ? { fdId: "person-1" } : undefined;
      },
      callOrg(_request, callback) {
        callback(null, { fdLoginName: "101-EKP-USER" });
      },
      setValue(id, value) {
        loadWrites.push([id, value]);
      }
    });

    assert.equal(actions.length, 2);
    assert.equal(onChange?.controlId, "fd_approver");
    assert.equal(onChange?.translationStatus, "mapped");
    assert.equal(onLoad?.translationStatus, "mapped");
    assert.equal(onChange.semanticHints.personPropertyHydration.property, "fdLoginName");
    assert.equal(onChange.semanticHints.personPropertyHydration.targetFieldId, "fd_appr_no");
    assert.equal(onLoad.semanticHints.personPropertyHydration.targetFieldId, "fd_appr_no");
    assert.match(onChange.function, /sysorg\.getPersonByPersonId/);
    assert.match(onLoad.function, /sysorg\.getPersonByPersonId/);
    assert.equal(
      draft.scripts.actions.every((action) => action.translationStatus !== "needs_review"),
      true
    );
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
    onChangeFn({ fdId: "person-1" });
    onLoadFn();
    assert.deepEqual(writes, [["fd_appr_no", "101-EKP-USER"]]);
    assert.deepEqual(loadWrites, [["fd_appr_no", "101-EKP-USER"]]);

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-09-05T00:00:00.000Z"
    });
    const execution = validateMigrationDsl(trusted, { mode: "execute" });
    assert.equal(execution.ok, true, JSON.stringify(execution.diagnostics));
  });
});
