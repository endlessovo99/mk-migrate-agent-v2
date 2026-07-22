import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { executeDsl } from "../../src/executor/execute.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { xformConfig } from "../helpers/persistence.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";

const sourcePath = "tests/fixtures/source/19975b570e5ee4617f912934a2eb4b77";
const fieldId = "fd_3d7e3b8607a54a";

describe("long description route projection", () => {
  it("bounds persisted labels without truncating description content", async () => {
    const sourceDraft = cleanSourceFile(sourcePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const description = dslDraft.form.fields.find((field) => field.id === fieldId);
    delete dslDraft.workflow;
    delete dslDraft.formRules;
    dslDraft.scripts.actions = [];

    assert.equal(description.type, "description");
    assert.equal(description.title.length > 200, true);

    const dsl = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-test-agent",
      checkedAt: "2026-07-12T00:00:00.000Z"
    });
    const adapter = new FakeNewoaAdapter("persist");
    const execution = await executeDsl(dsl, {
      client: adapter,
      confirmWrite: true,
      targetCategoryId: "route-category-id",
      credentials: {
        username: "route-test-user",
        encryptedPassword: "route-test-encrypted-password"
      },
      now: new Date("2026-07-12T00:00:00.000Z")
    });
    const config = xformConfig(adapter.template);
    const persisted = config.dataModel[0].fdFields.find((field) => field.fdName === fieldId);
    const attribute = JSON.parse(persisted.fdAttribute);

    assert.equal(execution.ok, true);
    assert.equal(execution.readback.partitions.form, "verified");
    assert.equal(persisted.fdLabel.length <= 200, true);
    assert.equal(attribute.config.controlProps.title, persisted.fdLabel);
    assert.equal(attribute.config.label, persisted.fdLabel);
    assert.equal(attribute.config.labelProps.title, persisted.fdLabel);
    assert.equal(attribute.config.controlProps.content, description.props.content);
    assert.equal(attribute.config.controlProps.defaultTextValue, description.props.content);
  });
});
