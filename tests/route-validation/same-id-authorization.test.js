import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolveWorkflowParticipants } from "../../src/executor/participant-resolver.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { persistAndVerify } from "../helpers/persistence.js";

const fixture = JSON.parse(readFileSync(new URL(
  "../fixtures/route-validation/same-id-authorization.json", import.meta.url
), "utf8"));

function routeDsl() {
  return sampleTrustedDsl({
    template: {
      authorization: {
        readerFlag: false,
        readers: [],
        editors: [fixture.source],
        allReaders: [fixture.source],
        allEditors: [fixture.source],
        temporaryReaders: [],
        temporaryEditors: []
      }
    }
  });
}

function resolve(dsl, candidates, targetFdId = fixture.source.sourceId) {
  return resolveWorkflowParticipants(dsl, {
    client: {
      async getElementInfo(ids) {
        assert.deepEqual(ids, [targetFdId]);
        return candidates;
      },
      async searchOrg() { assert.fail("Exact ID overrides must not search by name"); }
    },
    templateAuthorizationOverrides: [{ sourceId: fixture.source.sourceId, targetFdId }]
  });
}

describe("same-ID template authorization route", () => {
  it("persists renamed permissions and retains their source name in the audit", async () => {
    const dsl = routeDsl();
    const resolved = await resolve(dsl, [fixture.target]);
    const result = persistAndVerify(resolved.dsl);

    assert.equal(result.readback.ok, true, JSON.stringify(result.readback.diagnostics));
    assert.equal(resolved.templateAuthorizationOverrideCount, 3);
    assert.equal(resolved.templateAuthorizationOverrides[0].sourceEvidence.name, fixture.source.name);
    assert.equal(resolved.templateAuthorizationOverrides[0].target.fdName, fixture.target.fdName);
    assert.equal(resolved.dsl.template.authorization.editors[0].name, fixture.target.fdName);
    assert.deepEqual(result.template.fdEditors.map(member => member.fdId), [fixture.target.fdId]);
    assert.deepEqual(result.readback.workflow.templateAuthorization.allReaders, [fixture.target.fdId]);
    assert.equal(dsl.template.authorization.editors[0].name, fixture.source.name);
  });

  for (const [name, candidates, reason] of [
    ["missing ID", [], "template_authorization_override_target_not_found"],
    ["wrong ID", [{ ...fixture.target, fdId: "another-person" }], "template_authorization_override_target_not_found"],
    ["ambiguous ID", [fixture.target, fixture.target], "template_authorization_override_target_ambiguous"],
    ["wrong type", [{ ...fixture.target, fdOrgType: 4 }], "template_authorization_override_target_type_mismatch"]
  ]) {
    it(`rejects ${name} even when names are ignored for the same ID`, async () => {
      await assert.rejects(resolve(routeDsl(), candidates), error =>
        error.issues?.some(issue => issue.reason === reason));
    });
  }

  it("does not extend the name exception to a different target ID", async () => {
    const targetFdId = "different-person-id";
    await assert.rejects(resolve(routeDsl(), [{ ...fixture.target, fdId: targetFdId }], targetFdId), error =>
      error.issues?.some(issue => issue.reason === "template_authorization_override_target_name_mismatch"));
  });
});
