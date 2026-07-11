import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { main } from "../../src/cli/main.js";

const SOURCE_PATH = "tests/fixtures/route-validation/form-only/route-form-only_SysFormTemplate.xml";

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
