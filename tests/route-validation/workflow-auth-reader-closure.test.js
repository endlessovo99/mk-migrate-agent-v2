import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, sampleBaseTemplate } from "../helpers/persistence.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { executeDsl } from "../../src/executor/execute.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/route-validation/workflow-auth-reader-closure/authorization.json", import.meta.url), "utf8"));
const member = (id) => ({ id, name: id, targetOrgType: 8, sourceId: `source-${id}`, sourceOrgType: 8, sourceRef: `source.template.authorization.${id}` });
const ids = (members) => members.map(item => item.fdId).sort();
const route = (authorization = fixture.authorization) => {
  const dsl = sampleTrustedDsl({ template: { authorization: structuredClone(authorization) } });
  return { dsl, prepared: prepareSample(dsl) };
};

describe("formal workflow editor reading closure Route-validation", () => {
  it("projects already authorized formal editors into full readers without changing source DSL", () => {
    const { dsl, prepared } = route();
    assert.equal(checkExecute(dsl).ok, true);
    assert.deepEqual(dsl.template.authorization, fixture.authorization);
    assert.deepEqual(ids(prepared.update.fdReaders), fixture.expected.readers);
    assert.deepEqual(ids(prepared.update.fdEditors), fixture.expected.editors);
    assert.deepEqual(ids(prepared.update.fdAllReaders), fixture.expected.allReaders);
    assert.deepEqual(ids(prepared.update.fdAllEditors), fixture.expected.allEditors);
    const readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.deepEqual(readback.workflow.templateAuthorization, fixture.expected);
  });

  it("completes the fake executor and transfer record when the server materializes editor reading rights", async () => {
    await withNetworkGuard(async () => {
      const { dsl } = route();
      class NativeClosureClient extends FakeNewoaAdapter {
        async getElementInfo(targets, options) {
          const candidates = await super.getElementInfo(targets, options);
          const members = Object.values(dsl.template.authorization).filter(Array.isArray).flat();
          return candidates.map(candidate => {
            const member = members.find(member => member.id === candidate.fdId);
            return member ? { fdId: member.id, fdName: member.name, fdOrgType: member.targetOrgType, fdIsBusiness: true } : candidate;
          });
        }
        async getTemplate(id) {
          const template = await super.getTemplate(id);
          if (Array.isArray(template.fdAllReaders) && Array.isArray(template.fdEditors)) {
            template.fdAllReaders = [...new Map([...template.fdAllReaders, ...template.fdEditors].map(m => [m.fdId, m])).values()];
          }
          return template;
        }
      }
      const client = new NativeClosureClient("persist", { templateAuthorization: dsl.template.authorization });
      const result = await executeDsl(dsl, {
        client, credentials: { username: "route-user", encryptedPassword: "route-password" },
        baseUrl: "https://p-sit.onewo.com", targetCategoryId: "route-category-id", confirmWrite: true,
        templateAuthorizationOverrides: [
          { sourceId: "source-reader-r", targetFdId: "reader-r" },
          { sourceId: "source-editor-e", targetFdId: "editor-e" }
        ],
        now: new Date("2026-10-15T00:00:00Z"), transferRecordIdFactory: () => "route-reader-closure-record"
      });
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(result.readback.ok, true);
      assert.equal(result.transferRecord.status, "recorded");
      assert.equal(client.transcript().filter(call => call.operation === "add-transfer-record").length, 1);
    });
  });

  it("does not change the source readerFlag or the base native reader flag", () => {
    for (const readerFlag of [true, false]) {
      const { dsl } = route({ ...fixture.authorization, readerFlag });
      const prepared = prepareSample(dsl, { baseTemplate: sampleBaseTemplate({ fdReaderFlag: !readerFlag }) });
      assert.equal(dsl.template.authorization.readerFlag, readerFlag);
      assert.equal(prepared.update.fdReaderFlag, !readerFlag);
    }
  });

  it("accepts the observed native union while retaining exact membership assertions", () => {
    const { prepared } = route();
    const native = structuredClone(prepared.update);
    native.fdAllReaders = [...new Map([...native.fdAllReaders, ...native.fdEditors].map(m => [m.fdId, m])).values()];
    assert.equal(prepared.verify(native).ok, true);
    for (const mutate of [
      template => { template.fdAllReaders = template.fdAllReaders.filter(m => m.fdId !== "editor-e"); },
      template => { template.fdAllReaders = template.fdAllReaders.filter(m => m.fdId !== "reader-r"); },
      template => { template.fdAllReaders.push({ fdId: "unrelated-person", fdName: "Unrelated", fdOrgType: 8 }); },
      template => { template.fdAllEditors.push({ fdId: "reader-r", fdName: "Reader R", fdOrgType: 8 }); },
      template => { template.fdReaders.push({ fdId: "editor-e", fdName: "Editor E", fdOrgType: 8 }); }
    ]) {
      const changed = structuredClone(native); mutate(changed);
      const result = prepared.verify(changed);
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some(d => d.code === "readback.workflow.template_authorization_mismatch"));
    }
  });

  it("does not promote temporary members, creators or actors into full reading rights", () => {
    const authorization = { ...structuredClone(fixture.authorization), temporaryReaders: [member("temporary-reader")], temporaryEditors: [member("temporary-editor")] };
    const { prepared } = route(authorization);
    assert.deepEqual(ids(prepared.update.fdAllReaders), fixture.expected.allReaders);
    assert.deepEqual(ids(prepared.update.fdTmpReaders), ["temporary-reader"]);
    assert.deepEqual(ids(prepared.update.fdTmpEditors), ["temporary-editor"]);
    const changed = structuredClone(prepared.update);
    changed.fdCreator = { fdId: "creator-c", fdName: "Creator C" };
    assert.equal(prepared.verify(changed).ok, true);
    changed.fdAllReaders.push(changed.fdCreator);
    assert.equal(prepared.verify(changed).ok, false);
  });

  it("keeps an existing full-reader member once and adds only missing formal editors", () => {
    const authorization = structuredClone(fixture.authorization);
    authorization.editors = [member("direct-editor")];
    authorization.allReaders.push(member("direct-editor"));
    const { prepared } = route(authorization);
    assert.deepEqual(ids(prepared.update.fdAllReaders), ["direct-editor", "editor-e", "reader-r"]);
    assert.deepEqual(ids(prepared.update.fdAllEditors), ["direct-editor", "editor-e"]);
  });
});
