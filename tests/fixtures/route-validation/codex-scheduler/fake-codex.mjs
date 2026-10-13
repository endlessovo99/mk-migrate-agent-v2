#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const dir = dirname(process.cwd());
const task = JSON.parse(readFileSync(join(dir, "task.json")));
if (!prompt.includes(task.id) || !prompt.includes("最多允许 2 次")) process.exit(2);
const mode = process.env.MK_FAKE_CODEX_MODE || "success";
const noWrite = mode === "no-write";
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread-001" }));
if (process.env.MK_FAKE_CODEX_WAIT_FILE) {
  for (let attempt = 0; !existsSync(process.env.MK_FAKE_CODEX_WAIT_FILE); attempt++) {
    if (attempt >= 1200) process.exit(3);
    await delay(50);
  }
}
if (mode !== "prose-only") {
  const dsl = JSON.stringify({ derivedFrom: { sourceId: task.sourceId } });
  writeFileSync("migration-001.dsl.json", dsl);
  writeFileSync("write-intent-001.json", JSON.stringify({ version: 1, taskId: task.id,
    baseUrl: task.baseUrl, targetCategoryId: task.targetCategoryId, dslFile: "migration-001.dsl.json",
    dslSha256: createHash("sha256").update(dsl).digest("hex"), reportFile: "execution-001.report.json" }));
  if (mode !== "interrupted") writeFileSync("execution-001.report.json", JSON.stringify({
    ok: mode === "success", status: mode === "success" ? "written" : noWrite ? "blocked" : "readback_failed",
    remoteWriteAttempted: !noWrite, writeOutcomeUnknown: mode === "unknown", baseUrl: task.baseUrl,
    ...(noWrite ? { stage: "resolveWorkflowParticipants", createdFdIds: [], updatedFdIds: [],
      diagnostics: [{ level: "error", code: "workflow.participant_resolution_failed" }] } : {
      templateId: "fake-target", createdFdIds: ["fake-target"], readback: { ok: mode === "success" },
      transferRecord: { status: mode === "success" ? "recorded" : "not_attempted", fdId: "fake-record", fdOriginalId: task.sourceId, fdTargetId: "fake-target" }
    })
  }));
}
const output = process.argv[process.argv.indexOf("--output-last-message") + 1];
writeFileSync(output, "这是假 Codex 的成功自述，不能代替实际执行报告。\n");
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }));
if (mode === "interrupted") process.exit(1);
