import { it } from "node:test";
import assert from "node:assert/strict";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const SOURCE =
  "tests/fixtures/source2/16d622ad41c4bb720ab81b14e2eaa0b0";

it("accepts direct login-name branches sourced from a single-select main field", () => {
  const dslDraft = draftSourceDraft(cleanSourceFile(SOURCE));
  const mapped = dslDraft.workflow.nodes.filter((node) =>
    node.participants?.recipe === "main_field_contains_login_names"
  );
  const field = dslDraft.form.fields.find(
    (item) => item.id === mapped[0]?.participants?.fieldId
  );

  assert.equal(mapped.length, 9);
  assert.equal(field?.componentId, "xform-select");

  const validation = validateMigrationDsl(dslDraft, { mode: "draft" });
  assert.equal(
    validation.diagnostics.some((item) =>
      item.code === "workflow.participants.script_formula_main_field_component"
    ),
    false,
    JSON.stringify(validation.diagnostics, null, 2)
  );
});
