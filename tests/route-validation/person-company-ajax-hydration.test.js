import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runRouteCase } from "./run-route-case.js";

const fixture =
  "tests/fixtures/route-validation/person-company-ajax-hydration/route-person-company-ajax-hydration_SysFormTemplate.xml";

describe("person company ajax hydration Route case", { concurrency: false }, () => {
  it("omits id-suffix AttachXForm and XFormOnValueChangeFuns company ajax onto missing or non-text targets", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const attach = draft.scripts.actions.find((action) =>
      action.sourceRefs?.includes("source.form.jsp.jsp_person_org.script.1")
    );
    const valueChange = draft.scripts.actions.find((action) =>
      action.sourceRefs?.includes("source.form.jsp.jsp_display_name.script.1")
    );

    assert.equal(attach?.translationStatus, "omitted");
    assert.equal(attach.function, "");
    assert.equal(attach.functionMappings?.[0]?.basis, "legacy-runtime-noop");
    assert.match(attach.functionMappings[0].source, /fd_person_org|fd_person_dept|findCompByChildId/u);
    assert.equal(valueChange?.translationStatus, "omitted");
    assert.equal(valueChange.function, "");
    assert.equal(valueChange.functionMappings?.[0]?.basis, "legacy-runtime-noop");
    assert.match(valueChange.functionMappings[0].source, /fd_display_name|fd_person_org|findCompByChildId/u);
    assert.equal(
      draft.form.fields.some((field) => field.id === "fd_person_org"),
      false
    );
    assert.equal(
      draft.form.fields.some((field) => field.id === "fd_display_name"),
      false
    );
    assert.equal(
      draft.scripts.actions.every((action) => action.translationStatus !== "needs_review"),
      true,
      JSON.stringify(draft.scripts.actions.map((action) => [action.id, action.translationStatus]))
    );
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-09-05T00:00:00.000Z"
    });
    const execution = validateMigrationDsl(trusted, { mode: "execute" });
    assert.equal(execution.ok, true, JSON.stringify(execution.diagnostics));
  });

  it("persists the remaining person and company address fields without executable company ajax", async () => {
    const result = await runRouteCase("person-company-ajax-hydration-success");
    assert.equal(result.review.status, "needs_manual");
    assert.equal(result.execution.status, "written_with_warnings");
    assert.equal(
      result.review.diagnostics.some((item) => item.code === "source.function_not_whitelisted"),
      true
    );
    assert.equal(
      result.dsl.scripts.actions.every((action) => action.translationStatus === "omitted"),
      true
    );
    const person = result.execution.readback.form.fields.find((field) =>
      field.id === "fd_select_person"
    );
    const company = result.execution.readback.form.fields.find((field) =>
      field.id === "fd_company"
    );
    assert.equal(person.component, "xform-address");
    assert.equal(company.component, "xform-address");
  });
});
