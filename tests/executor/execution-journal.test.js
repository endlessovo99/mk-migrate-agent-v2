import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDsl } from "../../src/executor/execute.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { sampleBaseTemplate } from "../helpers/persistence.js";

const OPERATIONS = ["add", "update", "saveWorkflowDraft", "addTransferRecord"];
const OPTIONS = {
  credentials: { username: "journal-user", encryptedPassword: "journal-password" },
  confirmWrite: true,
  targetCategoryId: "category-id",
  transferRecordIdFactory: () => "journal-transfer-id"
};

describe("executeDsl durable write boundary", () => {
  it("awaits intent, API, and acknowledgement in order for every write without logging payloads", async () => {
    const trace = [];
    const events = [];
    const client = fakeClient(trace);
    const journal = {
      async beforeWrite(event) {
        await Promise.resolve();
        events.push(event);
        trace.push(`before:${event.operation}`);
      },
      async afterWrite(event) {
        await Promise.resolve();
        events.push(event);
        trace.push(`after:${event.operation}`);
      }
    };

    const report = await executeDsl(sampleTrustedDsl(), { ...OPTIONS, client, journal });
    assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
    assert.equal(report.remoteWriteAttempted, true);
    assert.equal(report.writeOutcomeUnknown, false);
    assert.deepEqual(trace, OPERATIONS.flatMap((name) => [`before:${name}`, name, `after:${name}`]));
    assert.deepEqual(events[1], { operation: "add", result: { targetTemplateId: "template-id" } });
    assert.deepEqual(events.at(-1), {
      operation: "addTransferRecord",
      targetTemplateId: "template-id",
      recordId: "journal-transfer-id",
      result: { targetTemplateId: "template-id", recordId: "journal-transfer-id" }
    });
    assert.equal(JSON.stringify(events).includes("journal-user"), false);
    assert.equal(JSON.stringify(events).includes("journal-password"), false);
    assert.equal(JSON.stringify(events).includes("fdConfig"), false);
  });

  for (const operation of OPERATIONS) {
    it(`does not call ${operation} when its intent cannot be persisted`, async () => {
      const trace = [];
      const report = await executeDsl(sampleTrustedDsl(), {
        ...OPTIONS,
        client: fakeClient(trace),
        journal: {
          async beforeWrite(event) { if (event.operation === operation) throw new Error("disk full"); },
          async afterWrite() {}
        }
      });
      assert.equal(report.ok, false);
      assert.equal(report.stage, operation);
      assert.deepEqual(trace, OPERATIONS.slice(0, OPERATIONS.indexOf(operation)));
      assert.equal(report.remoteWriteAttempted, operation !== "add");
      assert.equal(report.writeOutcomeUnknown, false);
      assert.equal(report.diagnostics.at(-1).code, "execute.journal_before_write_failed");
      if (operation === "addTransferRecord") {
        assert.equal(report.status, "transfer_record_failed");
        assert.equal(report.transferRecord.status, "not_attempted");
        assert.equal(report.readback.ok, true);
      }
    });

    it(`stops after ${operation} if its acknowledgement cannot be persisted`, async () => {
      const trace = [];
      const report = await executeDsl(sampleTrustedDsl(), {
        ...OPTIONS,
        client: fakeClient(trace),
        journal: {
          async beforeWrite() {},
          async afterWrite(event) { if (event.operation === operation) throw new Error("disk full"); }
        }
      });
      assert.equal(report.ok, false);
      assert.equal(report.stage, operation);
      assert.equal(report.templateId, "template-id");
      assert.deepEqual(report.createdFdIds, ["template-id"]);
      assert.equal(report.remoteWriteAttempted, true);
      assert.equal(report.writeOutcomeUnknown, true);
      assert.equal(report.writeOutcomeUnknownStage, operation);
      assert.equal(report.apiStages.at(-1).writeOutcomeUnknown, true);
      assert.deepEqual(trace, OPERATIONS.slice(0, OPERATIONS.indexOf(operation) + 1));
    });
  }

  it("classifies a lost add response as unknown even without a journal", async () => {
    const trace = [];
    const client = fakeClient(trace);
    client.addTemplate = async () => {
      trace.push("add");
      throw new Error("Connection closed after request was accepted");
    };
    const report = await executeDsl(sampleTrustedDsl(), { ...OPTIONS, client });
    assert.equal(report.stage, "add");
    assert.equal(report.remoteWriteAttempted, true);
    assert.equal(report.writeOutcomeUnknown, true);
    assert.equal(report.writeOutcomeUnknownStage, "add");
    assert.deepEqual(trace, ["add"]);
    assert.deepEqual(report.createdFdIds, []);
  });

  it("retains the remote-write marker when a later read fails", async () => {
    const trace = [];
    const client = fakeClient(trace);
    client.getTemplate = async () => { throw new Error("read timed out"); };
    const report = await executeDsl(sampleTrustedDsl(), { ...OPTIONS, client });
    assert.equal(report.stage, "get");
    assert.equal(report.remoteWriteAttempted, true);
    assert.equal(report.writeOutcomeUnknown, false);
    assert.deepEqual(report.createdFdIds, ["template-id"]);
    assert.deepEqual(trace, ["add"]);
  });

  it("journals existing-draft updates without creating a template", async () => {
    const trace = [];
    const client = fakeClient(trace);
    const created = await executeDsl(sampleTrustedDsl(), { ...OPTIONS, client });
    assert.equal(created.ok, true);
    trace.length = 0;
    const intents = [];
    const report = await executeDsl(sampleTrustedDsl(), {
      ...OPTIONS,
      client,
      targetTemplateId: created.templateId,
      journal: {
        async beforeWrite(event) { intents.push(event); },
        async afterWrite() {}
      }
    });
    assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
    assert.deepEqual(trace, OPERATIONS.slice(1));
    assert.deepEqual(intents.map((event) => event.operation), OPERATIONS.slice(1));
    assert.equal(intents.every((event) => event.targetTemplateId === created.templateId), true);
  });

  it("rejects an incomplete journal before any write", async () => {
    const trace = [];
    const report = await executeDsl(sampleTrustedDsl(), {
      ...OPTIONS, client: fakeClient(trace), journal: { async beforeWrite() {} }
    });
    assert.equal(report.remoteWriteAttempted, false);
    assert.equal(report.diagnostics.at(-1).code, "execute.journal_before_write_failed");
    assert.deepEqual(trace, []);
  });
});

function fakeClient(trace) {
  let template;
  let workflow;
  return {
    async login() {},
    async assertTransferRecordAuthentication() {},
    async initTemplate() { return sampleBaseTemplate(); },
    async generateTableName() { return "mk_model_test"; },
    async loadParentCategory(fdId) { return { fdFormCategoryId: fdId, fdName: "Test" }; },
    async searchOrg() { return []; },
    async getElementInfo() { return []; },
    async addTemplate(payload) { trace.push("add"); return { fdId: "template-id", fdName: payload.fdName }; },
    async getTemplate() { return template || sampleBaseTemplate(); },
    async updateTemplate(payload) { trace.push("update"); template = payload; return { fdId: payload.fdId }; },
    async saveWorkflowDraft(payload) { trace.push("saveWorkflowDraft"); workflow = payload; return { fdId: payload.fdId }; },
    async getWorkflowTemplateDetail() { return { ...workflow, isDraft: true, fdStatus: "draft" }; },
    async addTransferRecord(payload) { trace.push("addTransferRecord"); return { fdId: payload.fdId }; }
  };
}
