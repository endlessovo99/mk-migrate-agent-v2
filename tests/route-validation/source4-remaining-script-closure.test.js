import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const SOURCE4 = "tests/fixtures/source4";
const CLOSED_IDS = [
  "177bdce608766f2502ee0714130bb55e",
  "17c8337f9b9ff6feda7f8e24cb482a75",
  "184d0e88f3949b8870a0558420682dee",
  "1859e7bfaa39079c5e082ab45ada2a9a",
  "18a8356e42d059a3140a2644792895c3",
  "1923b93d7bcd8e63b7b743e45fba6361",
  "19a24476acdcc9ce5b708744206a2724",
  "19c9dac6eb80b3565aacdd64db6b7e34"
];

describe("Source4 remaining script-closure Route case", () => {
  it("trusts the remaining source4 fixtures after script semantic closure", () => {
    for (const sourceId of CLOSED_IDS) {
      const source = cleanSourceFile(`${SOURCE4}/${sourceId}`);
      const draft = draftSourceDraft(source);
      const reviewActions = (draft.scripts?.actions || [])
        .filter((action) => action.translationStatus === "needs_review")
        .map((action) => action.id);

      assert.deepEqual(reviewActions, [], sourceId);
      assert.equal(checkDraft(draft).ok, true, `${sourceId}: ${JSON.stringify(checkDraft(draft).diagnostics)}`);
      const trusted = createTrustedMigrationDsl(source, draft, {
        externalAgentReviewed: true,
        reviewerName: "route-validation",
        checkedAt: "2026-09-01T00:00:00.000Z"
      });
      const trust = checkTrust(source, trusted);
      assert.equal(trust.ok, true, `${sourceId}: ${JSON.stringify(trust.diagnostics)}`);
    }
  });
});
