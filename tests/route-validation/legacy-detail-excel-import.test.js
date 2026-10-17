import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { executeDsl } from "../../src/executor/execute.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const rawControlIds = "groupIndex;spmc;spbm;ggxh;dw;spsl;dj;je;slvno;slvno;slvno;slvno;slvno;sapxsdd;sapwbs;sapcgdd;";
const fixture = shape => `tests/fixtures/route-validation/legacy-detail-excel-import/route-${shape}_SysFormTemplate.xml`;

function stages(shape) {
  const source = cleanSourceFile(fixture(shape));
  const draft = draftSourceDraft(source);
  return { source, draft, action: draft.scripts.actions[0] };
}

describe("legacy positional detail Excel import Route-validation", { concurrency: false }, () => {
  for (const [shape, tableId] of [["prefixed", "fd_import_rows"], ["natural", "detailList"]]) {
    it(`retains ${shape} source table identity and every positional slot without inventing native compatibility`, () => {
      const { action } = stages(shape);
      assert.equal(action.translationStatus, "needs_review");
      assert.ok(action.coverage.residuals.some(item => item.code === "script.residual.legacy_excel_import_contract_unverified"));
      assert.ok(action.functionMappings.every(item => item.basis !== "legacy-runtime-noop"));
      const descriptor = action.semanticHints.legacyExcelImport;
      assert.equal(descriptor.tableId, tableId);
      assert.equal(descriptor.startRowNo, 4);
      assert.equal(descriptor.startCellNo, 0);
      assert.equal(descriptor.rawControlIds, rawControlIds);
      assert.deepEqual(descriptor.columnSlots, rawControlIds.split(";"));
      assert.equal(descriptor.columnSlots.length, 17);
      assert.deepEqual(descriptor.duplicateTargetSlots, [{ fieldId: "slvno", columnOffsets: [8, 9, 10, 11, 12] }]);
      assert.deepEqual(descriptor.emptyColumnOffsets, [16]);
      assert.equal(descriptor.tableDefinitionFound, true);
      assert.equal(descriptor.nativeImplementationVerified, false);
      assert.deepEqual(descriptor.sourceRefs, action.sourceRefs);
    });
  }

  it("retains source cancellation and confirmed replacement independently of a native parser assumption", () => {
    const { source } = stages("natural");
    const javascript = source.scripts.sources[0].javascript;
    for (const incoming of [null, [], [{ spmc: "first" }, { spmc: "second" }]]) {
      const rows = [{ spmc: "old" }, { spmc: "retained until confirmation" }];
      const operations = [];
      let params;
      const table = { id: "TABLE_DL_detailList", deleteRow(index) { operations.push("delete"); rows.splice(index - 1, 1); } };
      const context = {
        window: { showModalDialog(_url, values) { params = values; return incoming; } },
        Com_Parameter: { ContextPath: "/legacy/" },
        document: { getElementById(id) { assert.equal(id, table.id); return table; } },
        DocList_TableInfo: { [table.id]: { lastIndex: rows.length + 1 } },
        DocListFunc_RefreshIndex() {},
        DocList_AddRow(_table, _unused, value) { operations.push("add"); rows.push(value); }
      };
      vm.runInNewContext(`${javascript}\nimportExcel();`, context);
      assert.deepEqual(Array.from(params), ["detailList", rawControlIds, 4, 0]);
      assert.deepEqual(rows, incoming === null ? [{ spmc: "old" }, { spmc: "retained until confirmation" }] : incoming);
      assert.deepEqual(operations, incoming === null ? [] : ["delete", "delete", ...incoming.map(() => "add")]);
    }
  });

  it("does not allow native canImport presence to pass trust or execute a legacy positional import", async () => withNetworkGuard(async () => {
    const { source, draft } = stages("prefixed");
    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true, reviewerName: "route-test", checkedAt: "2026-10-17T00:00:00.000Z"
    });
    const trust = checkTrust(source, trusted);
    assert.equal(trust.ok, false);
    assert.ok(trust.diagnostics.some(item => item.code === "dsl.scripts.needs_review"));
    const client = new FakeNewoaAdapter("persist");
    const result = await executeDsl(trusted, {
      client, baseUrl: "https://p-sit.onewo.com", confirmWrite: true,
      credentials: { username: "fixture-user", encryptedPassword: "fixture-password" },
      targetCategoryId: "fixture-category"
    });
    assert.equal(result.ok, false);
    assert.equal(client.transcript().some(item => ["init", "add", "update", "save-workflow-draft", "add-transfer-record"].includes(item.operation)), false);
  }));
});
