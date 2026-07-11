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

  it("uses --template-name in the deterministic translate shortcut", async () => {
    const output = await captureJsonOutput(() => main([
      "translate",
      SOURCE_PATH,
      "--template-name",
      "原流程模板"
    ]));

    assert.equal(output.dsl.template.name, "原流程模板");
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
