import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/checkbox-other-option/route-checkbox-other-option_SysFormTemplate.xml";

describe("independent source choice/text in an unsupported compound detail cell", { concurrency: false }, () => {
  it("retains source options and both field identities while blocking the unproven detail presentation", () => {
    const source = cleanSourceFile(fixture), dsl = draftSourceDraft(source);
    const sourceTable = source.form.detailTables.find(t => t.id === "fd_nodes");
    const original = sourceTable.columns.find(c => c.id === "fd_node_auth");
    const table = dsl.form.fields.find(f => f.id === "fd_nodes");
    const auth = table.columns.find(c => c.id === "fd_node_auth");
    const other = table.columns.find(c => c.id === "fd_node_auth_other");
    const notice = dsl.form.fields.find(f => f.id === "fd_notice");
    assert.equal(auth.componentId, "xform-checkbox");
    assert.equal(auth.type, "checkbox");
    assert.deepEqual(original.options.map(o => o.value), ["1", "3", "4"]);
    assert.deepEqual(auth.props.options, original.options);
    assert.ok(auth.props.options.every(o => o.type !== "other"));
    assert.equal(other.componentId, "xform-input");
    assert.notEqual(other.dataOnly, true);
    assert.notEqual(other.props.required, true);
    assert.equal(auth.sourceProps.otherTextCompanion.id, other.id);
    assert.equal(notice.componentId, "xform-checkbox");
    assert.deepEqual(notice.props.options.map(o => o.value), ["1", "2"]);
    const check = checkDraft(dsl);
    assert.equal(check.ok, false);
    assert.ok(check.diagnostics.some(d => d.code === "source.form.choice_other_detail_layout_unproven"));
  });

  it("blocks the compound detail fixture before transport or transfer recording", async () => {
    const result = await runRouteCase("checkbox-other-option-detail-blocked-before-transport");
    assert.equal(result.review.status, "blocked");
    assert.equal(result.review.stage, "agent-review.input");
    assert.equal(result.execution, undefined);
    assert.equal(result.dryRun, undefined);
    assert.deepEqual(result.transcript, []);
  });
});
