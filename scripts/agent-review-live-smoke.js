#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgentReview } from "../src/agent-review/index.js";
import { cleanSourceFile, draftSourceDraft } from "../src/translator/index.js";

const fixturePath = "tests/fixtures/source/route-validation-lbpm";
const outputDir = ".tmp/agent-review-live";
const sourceDraftPath = join(outputDir, "source-draft.json");
const dslDraftPath = join(outputDir, "dsl-draft.json");
const migrationDslPath = join(outputDir, "migration.dsl.json");
const reportPath = join(outputDir, "agent-review.report.json");

mkdirSync(outputDir, { recursive: true });

const sourceDraft = cleanSourceFile(fixturePath);
const dslDraft = draftSourceDraft(sourceDraft);
writeJson(sourceDraftPath, sourceDraft);
writeJson(dslDraftPath, dslDraft);

const result = await runAgentReview(sourceDraft, dslDraft);
writeJson(reportPath, result.report);

if (result.ok) {
  writeJson(migrationDslPath, result.dsl);
  printJson({
    ok: true,
    status: result.status,
    stage: result.report.stage,
    provider: result.report.provider,
    baseUrl: result.report.baseUrl,
    model: result.report.model,
    wrote: migrationDslPath,
    reportWrote: reportPath
  });
  process.exit(0);
}

printJson({
  ok: false,
  status: "blocked",
  stage: result.report.stage,
  provider: result.report.provider,
  baseUrl: result.report.baseUrl,
  model: result.report.model,
  diagnostics: result.report.diagnostics,
  reportWrote: reportPath
});
process.exit(1);

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
