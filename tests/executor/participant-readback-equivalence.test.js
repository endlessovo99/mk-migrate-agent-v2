import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { participantsEquivalent } from "../../src/executor/persistence/compare.js";

describe("workflow participant readback equivalence", () => {
  it("accepts explicit and initiator-select normalization in either direction", () => {
    const common = {
      handlersType: "org",
      handlersSource: "1",
      handlersRuleKey: "",
      handlersRuleName: "",
      handlersElement: "users",
      members: [{
        id: "person-fallback",
        element: "user",
        type: "1"
      }]
    };
    const explicit = { mode: "explicit", ...common };
    const initiatorSelect = { mode: "initiator_select", ...common };

    assert.equal(participantsEquivalent(explicit, initiatorSelect), true);
    assert.equal(participantsEquivalent(initiatorSelect, explicit), true);
    assert.equal(
      participantsEquivalent(
        initiatorSelect,
        {
          ...explicit,
          members: [{ ...explicit.members[0], id: "different-person" }]
        }
      ),
      false
    );
  });
});
