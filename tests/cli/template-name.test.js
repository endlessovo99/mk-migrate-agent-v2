import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { main } from "../../src/cli/main.js";

const SOURCE_PATH = "tests/fixtures/route-validation/form-only/route-form-only_SysFormTemplate.xml";
const WORKFLOW_SOURCE_PATH = "tests/fixtures/source/route-validation-lbpm";
const WORKFLOW_REFERENCE_DIR = "tests/fixtures/source/workflow-reference-initdata";

describe("source template name CLI", () => {
  it("uses --template-name when cleaning source XML", async () => {
    const output = await captureJsonOutput(() => main([
      "clean",
      SOURCE_PATH,
      "--template-name",
      "原流程模板"
    ]));

    assert.equal(output.sourceDraft.template.name, "原流程模板");
  });

  it("reads KmReviewTemplate fdName from a paired source directory", async () => {
    const output = await captureJsonOutput(() => main([
      "clean",
      "tests/fixtures/route-validation/kmreview-named"
    ]));

    assert.equal(output.sourceDraft.template.name, "企业经营事项（其他类）审批流程");
  });

  it("lets --template-name override KmReviewTemplate fdName", async () => {
    const output = await captureJsonOutput(() => main([
      "clean",
      "tests/fixtures/route-validation/kmreview-named",
      "--template-name",
      "手动覆盖名称"
    ]));

    assert.equal(output.sourceDraft.template.name, "手动覆盖名称");
  });

  it("uses --template-name in the deterministic translate shortcut", async () => {
    const output = await captureJsonOutput(() => main([
      "translate",
      SOURCE_PATH,
      "--template-name",
      "原流程模板"
    ]));

    assert.equal(output.dsl.template.name, "原流程模板");
  });

  it("uses --workflow-reference-dir to emit fixed-post target IDs from initdata", async () => {
    const output = await captureJsonOutput(() => main([
      "translate",
      WORKFLOW_SOURCE_PATH,
      "--workflow-reference-dir",
      WORKFLOW_REFERENCE_DIR
    ]));
    const n3 = output.dsl.workflow.nodes.find((node) => node.id === "N3");

    assert.deepEqual(n3.participants.members, [{
      id: "reference-target-post-id",
      name: "参考目标岗位",
      type: "user_or_org",
      targetOrgType: 4
    }]);
  });

  it("rejects --template-name when its value is missing", async () => {
    const originalExitCode = process.exitCode;
    try {
      const output = await captureJsonOutput(() => main([
        "clean",
        SOURCE_PATH,
        "--template-name"
      ]));

      assert.equal(output.ok, false);
      assert.equal(output.message, "--template-name requires a non-empty value");
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("rejects --workflow-reference-dir when its value is missing", async () => {
    const originalExitCode = process.exitCode;
    try {
      const output = await captureJsonOutput(() => main([
        "clean",
        WORKFLOW_SOURCE_PATH,
        "--workflow-reference-dir"
      ]));

      assert.equal(output.ok, false);
      assert.equal(output.message, "--workflow-reference-dir requires a non-empty directory path");
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("rejects --workflow-reference-dir for a form-only source", async () => {
    const originalExitCode = process.exitCode;
    try {
      const output = await captureJsonOutput(() => main([
        "clean",
        SOURCE_PATH,
        "--workflow-reference-dir",
        WORKFLOW_REFERENCE_DIR
      ]));

      assert.equal(output.ok, false);
      assert.equal(output.message, "workflow reference requires a paired source directory");
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});

async function captureJsonOutput(run) {
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(String(value));
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(output.at(-1));
}
