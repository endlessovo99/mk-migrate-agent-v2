import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import {
  checkTrust,
  createTrustedMigrationDsl
} from "../../src/dsl/trust.js";
import {
  ParticipantResolutionError,
  resolveWorkflowParticipants
} from "../../src/executor/participant-resolver.js";
import {
  cleanSourceFile,
  draftSourceDraft
} from "../../src/translator/index.js";

const fixture =
  "tests/fixtures/source2/170e66b68b8eb9c2fdd57734d76a14fb";
const systemSupportFixture =
  "tests/fixtures/source2/179567ad1b153c4aa58c147454d90538";
const applicationSupportFixture =
  "tests/fixtures/source2/1708007339a649c4420f5b54fa6ae389";
const sourceId = "16a2e6340d037bfb1d64c9042d486835";
const systemSupportSourceId = "16a58a8ec6663e545e990b84f2cbd598";
const targetFdId = "current-zhang-kangyong";
const checkedAt = "2026-07-29T00:00:00.000Z";

describe("Route-validation Source2 companion participant evidence", {
  concurrency: false
}, () => {
  it("preserves an exact KmReviewTemplate person identity for a validated explicit override", async () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const sourceNode = sourceDraft.workflow.nodes.find((node) => node.id === "N4");
    const sourceMember = dslDraft.workflow.nodes
      .find((node) => node.id === "N4")
      .participants.members[0];
    const trusted = trustRouteDraft(sourceDraft, dslDraft);
    const searchedKeys = [];
    const client = {
      async searchOrg(key, orgType) {
        searchedKeys.push(key);
        if (key === "683-SYS-ZKY" && Number(orgType) === 8) {
          return [{
            fdId: "current-system-support",
            fdName: "张康永-系统支持",
            fdOrgType: 8,
            fdLoginName: "683-SYS-ZKY"
          }];
        }
        if (key === "总经理" && Number(orgType) === 4) {
          return [{
            fdId: "current-general-manager-post",
            fdName: "总经理",
            fdOrgType: 4,
            fdParentName: "电气数科公司领导"
          }];
        }
        return [];
      },
      async getElementInfo(targets) {
        assert.deepEqual(targets, [targetFdId]);
        return [{
          fdId: targetFdId,
          fdName: "张康永",
          fdOrgType: 8
        }];
      }
    };

    assert.equal(
      sourceNode.handlerEntities[0].evidenceSource,
      "kmReviewTemplate.rootHashMap"
    );
    assert.deepEqual(sourceMember, {
      name: "张康永",
      type: "user_or_org",
      sourceId,
      sourceOrgType: 8,
      sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgPerson",
      sourceLoginName: "68300032"
    });

    const resolved = await resolveWorkflowParticipants(trusted, {
      client,
      targetBaseUrl: "https://production.example.com",
      participantOverrides: [{ sourceId, targetFdId }]
    });
    const resolvedMember = resolved.dsl.workflow.nodes
      .find((node) => node.id === "N4")
      .participants.members[0];

    assert.equal(searchedKeys.includes("68300032"), false);
    assert.equal(resolved.overrideCount, 3);
    assert.equal(resolved.overrideIdentityCount, 1);
    assert.deepEqual(resolved.overrideTargetIds, [targetFdId]);
    assert.equal(
      Object.values(resolved.dsl.template.authorization)
        .flatMap((value) => Array.isArray(value) ? value : [])
        .filter((member) => member.sourceId === sourceId)
        .every((member) => member.id === targetFdId),
      true
    );
    assert.equal(resolvedMember.id, targetFdId);
    assert.equal(resolvedMember.name, "张康永");
    assert.equal(resolvedMember.targetOrgType, 8);
    assert.equal(resolvedMember.sourceId, sourceId);
    assert.equal(resolvedMember.sourceLoginName, "68300032");
  });

  it("keeps the system-support account distinct from the ordinary Zhang Kangyong identity", () => {
    const sourceDraft = cleanSourceFile(systemSupportFixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const sourceMember = dslDraft.workflow.nodes
      .find((node) => node.id === "N5")
      .participants.members[0];

    assert.deepEqual(sourceMember, {
      name: "张康永-系统支持",
      type: "user_or_org",
      sourceId: systemSupportSourceId,
      sourceOrgType: 8,
      sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgPerson",
      sourceLoginName: "683-SYS-ZKY"
    });
    assert.notEqual(sourceMember.sourceId, sourceId);
    assert.notEqual(sourceMember.sourceLoginName, "68300032");
  });

  it("does not recover a workflow identity absent from the paired KmReviewTemplate", async () => {
    const sourceDraft = cleanSourceFile(applicationSupportFixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const member = dslDraft.workflow.nodes
      .find((node) => node.id === "N4")
      .participants.members[0];
    const trusted = trustRouteDraft(sourceDraft, dslDraft);
    const client = {
      async searchOrg() {
        throw new Error("override rejection must happen before target search");
      },
      async getElementInfo() {
        throw new Error("override rejection must happen before target validation");
      }
    };

    assert.equal(member.id, systemSupportSourceId);
    assert.equal(member.name, "张康永-应用支持");
    assert.equal(member.sourceId, undefined);
    assert.equal(member.sourceLoginName, undefined);
    await assert.rejects(
      resolveWorkflowParticipants(trusted, {
        client,
        participantOverrides: [{
          sourceId: systemSupportSourceId,
          targetFdId
        }]
      }),
      (error) => error instanceof ParticipantResolutionError &&
        error.issues.some((issue) => issue.reason === "override_source_not_found")
    );
  });

  it("rejects conflicting identity records for the same source fdId", (t) => {
    const copiedFixture = copyFixture(t, fixture);
    updateFixtureXml(copiedFixture, "_KmReviewTemplate.xml", (xml) =>
      replaceOnce(xml, systemSupportSourceId, sourceId)
    );

    assertHandlerEvidenceNotRecovered(copiedFixture, "N4");
  });

  for (const scenario of [
    {
      name: "wrong org type",
      mutate: (record) => replaceOnce(record, "<int>8</int>", "<int>4</int>")
    },
    {
      name: "non-person class",
      mutate: (record) => replaceOnce(
        record,
        "com.landray.kmss.sys.organization.model.SysOrgPerson",
        "com.landray.kmss.sys.organization.model.SysOrgElement"
      )
    },
    {
      name: "missing login name",
      mutate: (record) => replaceOnce(
        record,
        "<string>68300032</string>",
        "<string></string>"
      )
    },
    {
      name: "inconsistent parent presence",
      mutate: (record) => replaceOnce(
        record,
        "<string></string>",
        "<string>冲突部门</string>"
      )
    },
    {
      name: "missing parent property",
      mutate: (record) => removeStringProperty(record, "hbmParent.fdName")
    }
  ]) {
    it(`rejects a duplicate with ${scenario.name} instead of keeping another valid record`, (t) => {
      const copiedFixture = copyFixture(t, fixture);
      updateFixtureXml(copiedFixture, "_KmReviewTemplate.xml", (xml) =>
        updateFirstPersonRecord(xml, sourceId, scenario.mutate)
      );

      assertHandlerEvidenceNotRecovered(copiedFixture, "N4");
    });
  }

  it("rejects the whole handler list when one participant has no companion evidence", (t) => {
    const copiedFixture = copyFixture(t, fixture);
    updateFixtureXml(copiedFixture, "_LbpmProcessDefinition.xml", (xml) =>
      replaceEvery(
        xml,
        `handlerIds=&quot;${sourceId}&quot; handlerNames=&quot;张康永&quot;`,
        `handlerIds=&quot;${sourceId};missing-source-person&quot; handlerNames=&quot;张康永;缺失人员&quot;`
      )
    );

    assertHandlerEvidenceNotRecovered(copiedFixture, "N4", 2);
  });

  it("rejects every claim when one workflow fdId has conflicting handler names", (t) => {
    const copiedFixture = copyFixture(t, fixture);
    updateFixtureXml(copiedFixture, "_LbpmProcessDefinition.xml", (xml) =>
      replaceEvery(
        xml,
        `handlerIds=&quot;${sourceId}&quot; handlerNames=&quot;张康永&quot;`,
        `handlerIds=&quot;${sourceId};${sourceId}&quot; handlerNames=&quot;张康永;张康永-应用支持&quot;`
      )
    );

    assertHandlerEvidenceNotRecovered(copiedFixture, "N4", 2);
  });

  it("rejects companion recovery that conflicts with an existing structured claim", (t) => {
    const copiedFixture = copyFixture(t, fixture);
    updateFixtureXml(copiedFixture, "_LbpmProcessDefinition.xml", (xml) =>
      insertRootPut(xml, structuredHandlerListPut({
        factId: "N5",
        id: sourceId,
        name: "张康永-结构化身份",
        loginName: "68300032"
      }))
    );

    const sourceDraft = cleanSourceFile(copiedFixture);
    const structuredNode = sourceDraft.workflow.nodes.find((node) => node.id === "N5");
    const companionNode = sourceDraft.workflow.nodes.find((node) => node.id === "N4");
    const dslMember = draftSourceDraft(sourceDraft).workflow.nodes
      .find((node) => node.id === "N4")
      .participants.members[0];

    assert.equal(structuredNode.handlerEntities[0].id, sourceId);
    assert.equal(structuredNode.handlerEntities[0].name, "张康永-结构化身份");
    assert.equal(companionNode.handlerEntities, undefined);
    assert.equal(dslMember.sourceId, undefined);
    assert.equal(dslMember.sourceLoginName, undefined);
  });

  it("preserves empty name slots and refuses positional misbinding", (t) => {
    const copiedFixture = copyFixture(t, fixture);
    updateFixtureXml(copiedFixture, "_LbpmProcessDefinition.xml", (xml) =>
      replaceEvery(
        xml,
        `handlerIds=&quot;${sourceId}&quot; handlerNames=&quot;张康永&quot;`,
        `handlerIds=&quot;${sourceId};${systemSupportSourceId}&quot; handlerNames=&quot;;张康永-系统支持&quot;`
      )
    );

    assertHandlerEvidenceNotRecovered(copiedFixture, "N4", 2);
  });

  it("uses a root fdName but never participant evidence when KmReview fdId is missing", (t) => {
    const copiedFixture = copyFixture(t, fixture);
    updateFixtureXml(copiedFixture, "_KmReviewTemplate.xml", (xml) =>
      replaceOnce(
        xml,
        `<string>fdId</string> \n   <string>170e66b68b8eb9c2fdd57734d76a14fb</string>`,
        `<string>missingFdId</string> \n   <string>170e66b68b8eb9c2fdd57734d76a14fb</string>`
      )
    );

    const sourceDraft = cleanSourceFile(copiedFixture);
    assert.equal(sourceDraft.template.name, "测试机器人人节点");
    assert.equal(sourceDraft.source.kmReviewTemplate.fdId, undefined);
    assertHandlerEvidenceNotRecovered(copiedFixture, "N4");
  });
});

function trustRouteDraft(sourceDraft, dslDraft) {
  const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
    externalAgentReviewed: true,
    reviewerName: "route-validation",
    checkedAt
  });
  const trust = checkTrust(sourceDraft, trusted);
  assert.equal(trust.ok, true, JSON.stringify(trust.diagnostics));
  return trusted;
}

function copyFixture(t, sourcePath) {
  const root = mkdtempSync(join(tmpdir(), "mk-source2-evidence-"));
  const target = join(root, basename(sourcePath));
  cpSync(sourcePath, target, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return target;
}

function updateFixtureXml(fixturePath, suffix, update) {
  const fileName = readdirSync(fixturePath).find((name) => name.endsWith(suffix));
  assert.ok(fileName, `missing fixture file ending with ${suffix}`);
  const path = join(fixturePath, fileName);
  const before = readFileSync(path, "utf8");
  const after = update(before);
  assert.notEqual(after, before, `fixture mutation did not change ${fileName}`);
  writeFileSync(path, after);
}

function replaceOnce(value, expected, replacement) {
  assert.equal(value.includes(expected), true, `fixture text not found: ${expected}`);
  return value.replace(expected, replacement);
}

function replaceEvery(value, expected, replacement) {
  assert.equal(value.includes(expected), true, `fixture text not found: ${expected}`);
  return value.split(expected).join(replacement);
}

function updateFirstPersonRecord(xml, id, update) {
  const idIndex = xml.indexOf(`<string>${id}</string>`);
  assert.notEqual(idIndex, -1, `person record not found: ${id}`);
  const start = xml.lastIndexOf('<object class="java.util.HashMap">', idIndex);
  const close = "</object>";
  const closeIndex = xml.indexOf(close, idIndex);
  assert.notEqual(start, -1, `person record start not found: ${id}`);
  assert.notEqual(closeIndex, -1, `person record end not found: ${id}`);
  const end = closeIndex + close.length;
  const record = xml.slice(start, end);
  const updated = update(record);
  assert.notEqual(updated, record, `person record mutation did not change: ${id}`);
  return `${xml.slice(0, start)}${updated}${xml.slice(end)}`;
}

function removeStringProperty(record, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\s*<void method="put">\\s*<string>${escaped}</string>\\s*<string>[^<]*</string>\\s*</void>`
  );
  assert.equal(pattern.test(record), true, `string property not found: ${property}`);
  return record.replace(pattern, "");
}

function insertRootPut(xml, putXml) {
  const marker = " </object> \n</java>";
  const index = xml.lastIndexOf(marker);
  assert.notEqual(index, -1, "root HashMap closing marker not found");
  return `${xml.slice(0, index)}${putXml}${xml.slice(index)}`;
}

function structuredHandlerListPut({ factId, id, name, loginName }) {
  return `  <void method="put">
   <string>nodeDefinitionHandlers</string>
   <object class="java.util.ArrayList">
    <void method="add">
     <object class="java.util.HashMap">
      <void method="put">
       <string>fdFactId</string>
       <string>${factId}</string>
      </void>
      <void method="put">
       <string>fdAttribute</string>
       <string>handlerIds</string>
      </void>
      <void method="put">
       <string>fdIndex</string>
       <int>0</int>
      </void>
      <void method="put">
       <string>fdHandler</string>
       <object class="java.util.HashMap">
        <void method="put">
         <string>fdId</string>
         <string>${id}</string>
        </void>
        <void method="put">
         <string>fdName</string>
         <string>${name}</string>
        </void>
        <void method="put">
         <string>fdOrgType</string>
         <int>8</int>
        </void>
        <void method="put">
         <string>fdLoginName</string>
         <string>${loginName}</string>
        </void>
        <void method="put">
         <string>class</string>
         <string>com.landray.kmss.sys.organization.model.SysOrgPerson</string>
        </void>
       </object>
      </void>
     </object>
    </void>
   </object>
  </void>
`;
}

function assertHandlerEvidenceNotRecovered(fixturePath, nodeId, memberCount = 1) {
  const sourceDraft = cleanSourceFile(fixturePath);
  const sourceNode = sourceDraft.workflow.nodes.find((node) => node.id === nodeId);
  const dslDraft = draftSourceDraft(sourceDraft);
  const members = dslDraft.workflow.nodes
    .find((node) => node.id === nodeId)
    .participants.members;

  assert.equal(sourceNode.handlerEntities, undefined);
  assert.equal(members.length, memberCount);
  assert.equal(members.every((member) => member.sourceId === undefined), true);
  assert.equal(members.every((member) => member.sourceLoginName === undefined), true);
}
