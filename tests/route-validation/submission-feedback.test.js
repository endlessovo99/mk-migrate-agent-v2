import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { prepareSample, formAttr, xformConfig } from "../helpers/persistence.js";
import { nativeRequiredRuntime } from "../helpers/native-required-runtime.js";
import { nativeMessageRuntime } from "../helpers/native-message-runtime.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/submission-feedback/submission-feedback_SysFormTemplate.xml";
const input = () => draftSourceDraft(cleanSourceFile(fixture));

describe("submission feedback Route", () => {
  it("executes source, review, trust, persistence and readback through the public route", async () => {
    const result = await runRouteCase("submission-feedback-native-message-success");
    assert.deepEqual(result.review.diagnostics.map(d => d.code), ["source.function_not_whitelisted"]);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.readback.ok, true);
    assert.equal(result.transcript.at(-1).operation, "add-transfer-record");
  });
  it("keeps a row heading optional while required detail columns follow source selection", () => {
    const dsl = input();
    assert.deepEqual(checkDraft(dsl).diagnostics.filter(d => d.level === "error"), []);
    const prepared = prepareSample(dsl), config = xformConfig(prepared.update);
    const main = config.dataModel.find(model => model.fdType === "main").fdTableName;
    const table = config.dataModel.find(model => model.fdType === "detail").fdTableName;
    const action = formAttr(prepared.update).controlAction.control[`${main}.fd_mode`].onChange[0];
    const runtime = nativeRequiredRuntime(config);
    const execute = vm.runInNewContext(`(${action.function})`, { MKXFORM: runtime.MKXFORM });
    for (const value of ["YES", "NO", "", "YES"]) {
      execute(value);
      assert.equal(runtime.required("fd_heading"), false, "The heading has no user-entered value");
      assert.equal(runtime.detailRequired(table, "fd_person_name"), value === "YES");
      assert.equal(runtime.detailRequired(table, "fd_note"), false);
      assert.equal(runtime.field("fd_heading").labelProps.hidden, value !== "YES");
    }
    assert.equal(prepared.verify(prepared.update).ok, true);
  });

  for (const platform of ["desktop", "mobile"]) {
    it(`retains the rejected submit reason on ${platform} through the native API`, () => {
      const prepared = prepareSample(input());
      const action = formAttr(prepared.update).controlAction.global.onBeforeSubmit[0];
      for (const [amount, isDraft, expected] of [[-1, false, false], [0, false, true], [1, false, true], [-1, true, true]]) {
        const native = nativeMessageRuntime(platform);
        const execute = vm.runInNewContext(`(${action.function})`, {
          MKXFORM: { ...native.MKXFORM, viewStatus: "add", getValue: () => amount }
        });
        assert.equal(execute({ isDraft }), expected);
        assert.deepEqual(native.messages, expected ? [] : ["金额不得小于0"]);
        if (!expected) assert.equal(native.calls[0].method, platform === "mobile" ? "toast" : "message.error");
      }
    });
  }

  it("preserves a dynamic travel row-number diagnostic on both platforms", () => {
    const dsl = draftSourceDraft(cleanSourceFile("tests/fixtures/route-validation/travel-reimbursement-lifecycle/route-travel-reimbursement-lifecycle_SysFormTemplate.xml"));
    const action = dsl.scripts.actions.find(action => action.functionMappings.some(mapping => mapping.basis === "deterministic-travel-reimbursement-submit-calculation"));
    for (const platform of ["desktop", "mobile"]) {
      const native = nativeMessageRuntime(platform);
      const execute = vm.runInNewContext(`(${action.function})`, {
        MKXFORM: { ...native.MKXFORM, viewStatus: "add", setValue() {}, getValue: id =>
          id === "fd_is_project" ? "1" : id.includes("fd_project_num_list")
            ? [{ fd_bseg_projk: "missing-project-A" }, { fd_bseg_projk: "missing-project-B" }]
            : [] }
      });
      assert.equal(execute({ isDraft: false }), false);
      assert.deepEqual(native.messages, ["第1、2行的项目/令号不存在，请重新填写。"]);
      assert.equal(native.calls.length, 1);
    }
  });

  it("pins the exact native message and toast factory excerpts", () => {
    const base = new URL("../fixtures/executor/persistence/message-runtime/", import.meta.url);
    const provenance = JSON.parse(readFileSync(new URL("provenance.json", base), "utf8"));
    for (const part of provenance.modules) {
      const source = readFileSync(new URL(part.file, base), "utf8");
      assert.equal(createHash("sha256").update(source).digest("hex"), part.sha256);
    }
  });
});
