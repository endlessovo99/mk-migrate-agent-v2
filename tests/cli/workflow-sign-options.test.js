import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { main } from "../../src/cli/main.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
const policy = JSON.parse(readFileSync("tests/fixtures/route-validation/workflow-sign/sign-policy.json"));
it("passes sign policy and exact structured operation overrides only when explicitly supplied", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sign-cli-"));
  const file = join(directory, "dsl.json"), mappings = join(directory, "mappings.json");
  writeFileSync(file, JSON.stringify(sampleTrustedDsl())); writeFileSync(mappings, JSON.stringify(policy.workflowOperationSetOverrides));
  const previous = console.log, previousExitCode = process.exitCode;
  const calls = [], output = []; console.log = value => output.push(String(value));
  try {
    const settings = { env: {}, executeDsl: async (_dsl, options) => { calls.push(options); return { ok: true }; } };
    await main(["execute", file], settings);
    assert.equal(Object.hasOwn(calls[0], "workflowSignDocumentPolicy"), false);
    assert.equal(Object.hasOwn(calls[0], "workflowOperationSetOverrides"), false);
    await main(["execute", file, "--workflow-sign-document-policy", "form-only-audit", "--workflow-operation-set-overrides", mappings], settings);
    assert.equal(calls[1].workflowSignDocumentPolicy, "form-only-audit");
    assert.deepEqual(calls[1].workflowOperationSetOverrides, policy.workflowOperationSetOverrides);
    await main(["execute", file, "--workflow-sign-document-policy", "ignore-permissions"], settings);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(JSON.parse(output.at(-1)), { ok: false, status: "error", message: "Invalid explicit sign execution options." });
    assert.equal(calls.length, 2);
  } finally { console.log = previous; process.exitCode = previousExitCode; rmSync(directory, { recursive: true, force: true }); }
});
