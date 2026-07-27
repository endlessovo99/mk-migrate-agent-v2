import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixturePath = "tests/fixtures/source/1887a98750756b5ba35b02047e6a6a30";
const fieldId = "fd_3c70c50a0493ce";

describe("procurement payment rich-text Route case", () => {
  it("keeps the unconditionally rendered contract terms in the visible form layout", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const sourceField = sourceDraft.form.controls.find((field) => field.id === fieldId);
    const dslField = dslDraft.form.fields.find((field) => field.id === fieldId);
    const layoutRefs = dslDraft.form.layout.sourceGrid.rows.flatMap((row) =>
      row.cells.flatMap((cell) =>
        (cell.references || []).map((reference) => reference.referenceId)
      )
    );

    assert.equal(sourceField?.sourceType, "longText");
    assert.equal(sourceDraft.form.dataFields.some((field) => field.id === fieldId), false);
    assert.equal(dslField?.componentId, "xform-rich-text");
    assert.notEqual(dslField?.dataOnly, true);
    assert.equal(layoutRefs.filter((referenceId) => referenceId === fieldId).length, 1);
    assert.ok(layoutRefs.indexOf(fieldId) > layoutRefs.indexOf("fd_vendor_account"));
    assert.ok(layoutRefs.indexOf(fieldId) < layoutRefs.indexOf("fd_contract_content"));
    assert.equal(
      sourceDraft.issues.some((issue) =>
        issue.code === "source.sysform.display_jsp_visibility_override" &&
        issue.evidence?.fieldId === fieldId
      ),
      true
    );

    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-07-28T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);
    const observedField = readback.form.fields.find((field) => field.id === fieldId);

    assert.equal(
      readback.partitions.form,
      "verified",
      JSON.stringify(readback.diagnostics.filter((diagnostic) => diagnostic.partition === "form"))
    );
    assert.equal(observedField?.component, "xform-rich-text");
    assert.equal(observedField?.dataOnly, false);
  });
});
