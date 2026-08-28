import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { resolveWorkflowParticipants } from "../../src/executor/participant-resolver.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { localCorpusIt } from "../helpers/local-corpus.js";

const ROUTE_FIXTURE_PATH =
  "tests/fixtures/route-validation/structured-direct-person";
const LOCAL_SOURCE3_PATH =
  "tests/fixtures/source3/166d859bc79f49f5acf97474d9fa5d85";
const TARGET_PERSON_ID = "18162bf47dd1b55ef2a421b49e685da7";
const CACHED_PERSON_ID = "181f2b5fc8d191aa0d5cb74404abc689";
const OPTIONAL_PERSON_ID = "18162bf47dd1b55ef2a421b49e685da8";
const EQUAL_CACHE_PERSON_ID = "18162bf47dd1b55ef2a421b49e685da9";
const FALLBACK_PERSON_ID = "current-fallback-person-id";

describe("structured direct-person targets", () => {
  it("maps the structured N38 handler fdId instead of the reviewNode cache", () => {
    const n38 = n38From(ROUTE_FIXTURE_PATH);

    assert.equal(n38.attributes.handlerIds, CACHED_PERSON_ID);
    assert.deepEqual(n38.participants.members, [expectedTargetPerson()]);
    assert.deepEqual(n38.participants.alternativeMembers, [expectedOptionalPerson()]);
    assert.equal(checkDraft(draftFrom(ROUTE_FIXTURE_PATH)).ok, true);
  });

  it("maps every structured orgType 8 handler even when its fdId equals the cache", () => {
    const n39 = draftFrom(ROUTE_FIXTURE_PATH).workflow.nodes.find((node) => node.id === "N39");

    assert.equal(n39.attributes.handlerIds, EQUAL_CACHE_PERSON_ID);
    assert.deepEqual(n39.participants.members, [{
      id: EQUAL_CACHE_PERSON_ID,
      name: "同值人员",
      type: "user_or_org",
      targetOrgType: 8
    }]);
  });

  localCorpusIt("maps source3 N38 from its structured handler record", () => {
    const n38 = n38From(LOCAL_SOURCE3_PATH);

    assert.equal(n38.attributes.handlerIds, CACHED_PERSON_ID);
    assert.deepEqual(n38.participants.members, [expectedTargetPerson()]);
  });

  it("validates the exact structured person fdId without search or fallback", async () => {
    const searchCalls = [];
    const elementCalls = [];
    const resolved = await resolveWorkflowParticipants(workflowWithN38(), {
      targetBaseUrl: "https://p-sit.onewo.com",
      fallbackFdIds: { person: "must-not-be-used" },
      client: {
        async searchOrg(...args) {
          searchCalls.push(args);
          return [];
        },
        async getElementInfo(targetIds) {
          elementCalls.push(targetIds);
          return [{
            fdId: TARGET_PERSON_ID,
            fdName: "陆佳诚",
            fdOrgType: 8
          }];
        }
      }
    });

    assert.deepEqual(searchCalls, []);
    assert.deepEqual(elementCalls, [[TARGET_PERSON_ID]]);
    assert.equal(resolved.fallbackCount, 0);
    assert.deepEqual(resolved.dsl.workflow.nodes[0].participants.members, [expectedTargetPerson()]);
  });

  it("validates an equal-cache optional orgType 8 handler without search or fallback", async () => {
    const n38 = n38From(ROUTE_FIXTURE_PATH);
    n38.participants.members = [];
    const searchCalls = [];
    const elementCalls = [];
    const resolved = await resolveWorkflowParticipants({ workflow: { nodes: [n38] } }, {
      targetBaseUrl: "https://p-sit.onewo.com",
      fallbackFdIds: { person: "must-not-be-used" },
      client: {
        async searchOrg(...args) {
          searchCalls.push(args);
          return [];
        },
        async getElementInfo(targetIds) {
          elementCalls.push(targetIds);
          return [{
            fdId: OPTIONAL_PERSON_ID,
            fdName: "备选人员",
            fdOrgType: 8
          }];
        }
      }
    });

    assert.deepEqual(searchCalls, []);
    assert.deepEqual(elementCalls, [[OPTIONAL_PERSON_ID]]);
    assert.equal(resolved.fallbackCount, 0);
    assert.deepEqual(
      resolved.dsl.workflow.nodes[0].participants.alternativeMembers,
      [expectedOptionalPerson()]
    );
  });

  it("blocks when the exact structured person fdId is missing", async () => {
    const searchCalls = [];
    const elementCalls = [];

    await assert.rejects(
      () => resolveWorkflowParticipants(workflowWithN38(), {
        targetBaseUrl: "https://p-sit.onewo.com",
        fallbackFdIds: { person: "must-not-be-used" },
        client: {
          async searchOrg(...args) {
            searchCalls.push(args);
            return [];
          },
          async getElementInfo(targetIds) {
            elementCalls.push(targetIds);
            return [];
          }
        }
      }),
      (error) => {
        assert.equal(error.issues?.[0]?.reason, "not_found");
        assert.equal(error.issues?.[0]?.targetId, TARGET_PERSON_ID);
        return true;
      }
    );
    assert.deepEqual(searchCalls, []);
    assert.deepEqual(elementCalls, [[TARGET_PERSON_ID]]);
  });

  it("applies an explicitly authorized person fallback after exact target absence is confirmed", async () => {
    const searchCalls = [];
    const elementCalls = [];
    const resolved = await resolveWorkflowParticipants(workflowWithN38(), {
      targetBaseUrl: "https://p-sit.onewo.com",
      fallbackFdIds: { person: FALLBACK_PERSON_ID },
      allowMissingDirectPersonFallback: true,
      client: {
        async searchOrg(...args) {
          searchCalls.push(args);
          return [];
        },
        async getElementInfo(targetIds) {
          elementCalls.push(targetIds);
          if (targetIds.includes(FALLBACK_PERSON_ID)) {
            return [{
              fdId: FALLBACK_PERSON_ID,
              fdName: "迁移兜底人员",
              fdOrgType: 8
            }];
          }
          return [];
        }
      }
    });

    assert.deepEqual(searchCalls, []);
    assert.deepEqual(elementCalls, [[TARGET_PERSON_ID], [FALLBACK_PERSON_ID]]);
    assert.equal(resolved.fallbackCount, 1);
    assert.equal(resolved.directTargetFallbackCount, 1);
    assert.equal(resolved.directTargetFallbackIdentityCount, 1);
    assert.deepEqual(resolved.dsl.workflow.nodes[0].participants.members, [{
      id: FALLBACK_PERSON_ID,
      name: "迁移兜底人员",
      type: "user_or_org",
      targetOrgType: 8
    }]);
    assert.deepEqual(resolved.directTargetFallbacks, [{
      missingTarget: {
        fdId: TARGET_PERSON_ID,
        fdName: "陆佳诚",
        fdOrgType: 8
      },
      fallbackTarget: {
        fdId: FALLBACK_PERSON_ID,
        fdName: "迁移兜底人员",
        fdOrgType: 8
      },
      referenceCount: 1,
      paths: ["/workflow/nodes/0/participants/members/0"]
    }]);
  });

  it("does not extend direct-person fallback authorization to a direct post", async () => {
    const workflow = workflowWithN38();
    workflow.workflow.nodes[0].participants.members[0].targetOrgType = 4;
    const elementCalls = [];

    await assert.rejects(
      () => resolveWorkflowParticipants(workflow, {
        targetBaseUrl: "https://p-sit.onewo.com",
        fallbackFdIds: { person: FALLBACK_PERSON_ID },
        allowMissingDirectPersonFallback: true,
        client: {
          async getElementInfo(targetIds) {
            elementCalls.push(targetIds);
            return [];
          }
        }
      }),
      (error) => {
        assert.equal(error.issues?.[0]?.reason, "not_found");
        return true;
      }
    );
    assert.deepEqual(elementCalls, [[TARGET_PERSON_ID]]);
  });

  it("scopes an untyped legacy person fallback to one explicitly authorized direct fdId", async () => {
    const workflow = workflowWithN38();
    delete workflow.workflow.nodes[0].participants.members[0].targetOrgType;
    const elementCalls = [];
    const resolved = await resolveWorkflowParticipants(workflow, {
      targetBaseUrl: "https://p-sit.onewo.com",
      fallbackFdIds: { person: FALLBACK_PERSON_ID },
      directPersonFallbackIds: [TARGET_PERSON_ID],
      client: {
        async getElementInfo(targetIds) {
          elementCalls.push(targetIds);
          if (targetIds.includes(FALLBACK_PERSON_ID)) {
            return [{
              fdId: FALLBACK_PERSON_ID,
              fdName: "迁移兜底人员",
              fdOrgType: 8
            }];
          }
          return [];
        }
      }
    });

    assert.deepEqual(elementCalls, [[TARGET_PERSON_ID], [FALLBACK_PERSON_ID]]);
    assert.equal(resolved.directTargetFallbackCount, 1);
    assert.equal(resolved.directTargetFallbacks[0].authorization, "explicit_direct_person_id");
    assert.deepEqual(resolved.dsl.workflow.nodes[0].participants.members[0], {
      id: FALLBACK_PERSON_ID,
      name: "迁移兜底人员",
      type: "user_or_org",
      targetOrgType: 8
    });
  });

  it("blocks when the exact structured fdId is not a person", async () => {
    const searchCalls = [];
    const elementCalls = [];

    await assert.rejects(
      () => resolveWorkflowParticipants(workflowWithN38(), {
        targetBaseUrl: "https://p-sit.onewo.com",
        fallbackFdIds: { person: "must-not-be-used" },
        client: {
          async searchOrg(...args) {
            searchCalls.push(args);
            return [];
          },
          async getElementInfo(targetIds) {
            elementCalls.push(targetIds);
            return [{
              fdId: TARGET_PERSON_ID,
              fdName: "错误岗位目标",
              fdOrgType: 4
            }];
          }
        }
      }),
      (error) => {
        assert.equal(error.issues?.[0]?.reason, "target_type_mismatch");
        assert.equal(error.issues?.[0]?.expectedOrgType, 8);
        assert.equal(error.issues?.[0]?.targetOrgType, 4);
        return true;
      }
    );
    assert.deepEqual(searchCalls, []);
    assert.deepEqual(elementCalls, [[TARGET_PERSON_ID]]);
  });

  it("blocks conflicting structured person records before lookup or fallback", async () => {
    const n38 = n38From(ROUTE_FIXTURE_PATH);
    n38.directTargetAmbiguities = [{
      attribute: "handlerIds",
      index: 0,
      cachedId: CACHED_PERSON_ID,
      targetIds: [TARGET_PERSON_ID, "another-target-person-id"]
    }];
    const searchCalls = [];
    const elementCalls = [];

    await assert.rejects(
      () => resolveWorkflowParticipants({ workflow: { nodes: [n38] } }, {
        targetBaseUrl: "https://p-sit.onewo.com",
        fallbackFdIds: { person: "must-not-be-used" },
        client: {
          async searchOrg(...args) {
            searchCalls.push(args);
            return [];
          },
          async getElementInfo(...args) {
            elementCalls.push(args);
            return [];
          }
        }
      }),
      (error) => {
        assert.equal(error.issues?.[0]?.reason, "direct_target_ambiguous");
        return true;
      }
    );
    assert.deepEqual(searchCalls, []);
    assert.deepEqual(elementCalls, []);
  });
});

function draftFrom(path) {
  return draftSourceDraft(cleanSourceFile(path));
}

function n38From(path) {
  return draftFrom(path).workflow.nodes.find((node) => node.id === "N38");
}

function workflowWithN38() {
  const n38 = n38From(ROUTE_FIXTURE_PATH);
  delete n38.participants.alternativeMembers;
  return { workflow: { nodes: [n38] } };
}

function expectedTargetPerson() {
  return {
    id: TARGET_PERSON_ID,
    name: "陆佳诚",
    type: "user_or_org",
    targetOrgType: 8
  };
}

function expectedOptionalPerson() {
  return {
    id: OPTIONAL_PERSON_ID,
    name: "备选人员",
    type: "user_or_org",
    targetOrgType: 8
  };
}
