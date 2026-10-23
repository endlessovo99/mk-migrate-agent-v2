import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export async function runCleanFixture(mode, args) {
  if (args[0] === "status") {
    console.log(JSON.stringify({ status: "unlocked", releaseId: "clean-output-fixture", sha256: "b".repeat(64) }));
    return;
  }
  if (args[0] !== "run" || args[1] !== "--" || args[2] !== "clean") throw new Error("Only offline clean is allowed");
  const output = args[args.indexOf("--out") + 1];
  if (mode === "real-clean") {
    const { startCli } = await import("../../../../src/cli/main.js");
    await startCli(args.slice(2), { env: {}, defaultEnvFile: join(dirname(output), "absent-fixture.env") });
    // JSON whitespace stresses the transport limit without a large/slow XML parser fixture.
    const { stdoutPaddingBytes } = JSON.parse(readFileSync(new URL("./clean-output.json", import.meta.url)));
    process.stdout.write(" ".repeat(stdoutPaddingBytes));
  } else if (mode === "missing-output") {
    console.log("fixture exited without writing its artifact");
  } else if (mode === "timeout") {
    console.log("fixture clean started");
    console.error("FIXTURE_CLEAN_WAITING");
    await delay(30000);
  } else {
    writeFileSync(output, JSON.stringify({ source: { sourceId: "fixture" } }));
    console.log("fixture partial artifact written");
    console.error("FIXTURE_CLEAN_FAILURE_DETAIL");
    process.exitCode = 23;
  }
}
