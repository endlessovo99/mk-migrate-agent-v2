#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDefaultEnvironment } from "../default-environment.js";
import { runAgentReview } from "../agent-review/index.js";
import { checkDraft, checkExecute } from "../dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../dsl/trust.js";
import { buildDryRunPlan } from "../executor/dry-run.js";
import { executeDsl } from "../executor/execute.js";
import { repairLockedDraft } from "../executor/locked-draft-repair.js";
import { reconcileTransferRecord } from "../executor/reconcile-transfer-record.js";
import { loadFunctionWhitelist } from "../translator/function-whitelist.js";
import { cleanSourceFile, draftSourceDraft, translateSourceFile } from "../translator/index.js";
import { selectNewoaBaseUrl } from "./base-url.js";
import { selectFallbackFdIds } from "./fallback-fd-ids.js";

const commands = new Map([
  ["clean", runClean],
  ["draft", runDraft],
  ["translate", runTranslate],
  ["agent-review", runAgentReviewCommand],
  ["trust", runTrust],
  ["check", runCheck],
  ["validate", runValidate],
  ["dry-run", runDryRun],
  ["execute", runExecute],
  ["reconcile-transfer-record", runReconcileTransferRecord],
  ["repair-locked-draft", runRepairLockedDraft]
]);

export async function main(argv = [], options = {}) {
  const [commandName, ...rest] = argv;
  const command = commands.get(commandName);

  if (!command) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  try {
    await command(rest, options);
  } catch (error) {
    process.exitCode = 1;
    printJson({
      ok: false,
      status: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function startCli(argv = [], options = {}) {
  const env = options.env || process.env;
  loadDefaultEnvironment({ path: options.defaultEnvFile, env });
  await main(argv, { ...options, env });
}

function runClean(argv) {
  const args = parseArgs(argv);
  const sourcePath = args.positionals[0];
  if (!sourcePath) throw new Error("clean requires a source path");

  const sourceDraft = cleanSourceFile(sourcePath, {
    functionWhitelist: loadWhitelist(args),
    templateName: readTemplateNameOption(args),
    workflowReferenceDir: readWorkflowReferenceDirOption(args)
  });
  writeOrPrint(args, sourceDraft, {
    ok: true,
    status: "passed",
    artifact: sourceDraft.artifact,
    sourceDraft
  });
}

function runDraft(argv) {
  const args = parseArgs(argv);
  const inputPath = args.positionals[0];
  if (!inputPath) throw new Error("draft requires a source-draft path");

  const dslDraft = draftSourceDraft(readJson(inputPath));
  const check = checkDraft(dslDraft);
  writeOrPrint(args, dslDraft, {
    ...check,
    artifact: dslDraft.artifact,
    dsl: dslDraft
  });
}

function runTranslate(argv) {
  const args = parseArgs(argv);
  const sourcePath = args.positionals[0];
  if (!sourcePath) throw new Error("translate requires a source path");

  const dsl = translateSourceFile(sourcePath, {
    functionWhitelist: loadWhitelist(args),
    templateName: readTemplateNameOption(args),
    workflowReferenceDir: readWorkflowReferenceDirOption(args)
  });
  const check = checkDraft(dsl);
  writeOrPrint(args, dsl, {
    ...check,
    artifact: dsl.artifact,
    dsl
  });
}

function runTrust(argv) {
  const args = parseArgs(argv);
  const sourceDraftPath = args.positionals[0];
  const dslDraftPath = args.positionals[1];
  if (!sourceDraftPath || !dslDraftPath) {
    throw new Error("trust requires <source-draft.json> <dsl-draft.json>");
  }

  const trusted = createTrustedMigrationDsl(readJson(sourceDraftPath), readJson(dslDraftPath), {
    externalAgentReviewed: args["external-agent-reviewed"] === true,
    reviewerName: args["reviewer-name"],
    checkedAt: args["checked-at"]
  });
  const check = checkTrust(readJson(sourceDraftPath), trusted);
  writeOrPrint(args, trusted, {
    ...check,
    artifact: trusted.artifact,
    dsl: trusted
  });
}

async function runAgentReviewCommand(argv, options = {}) {
  const args = parseArgs(argv);
  const sourceDraftPath = args.positionals[0];
  const dslDraftPath = args.positionals[1];
  if (!sourceDraftPath || !dslDraftPath) {
    throw new Error("agent-review requires <source-draft.json> <dsl-draft.json>");
  }
  if (!args.out) {
    throw new Error("agent-review requires --out <migration.dsl.json>");
  }
  const sourceDraft = readJson(sourceDraftPath);
  const dslDraft = readJson(dslDraftPath);
  const resumeCheckpoint = args["resume-from"] ? readJson(args["resume-from"]) : undefined;
  rmSync(args.out, { force: true });
  const checkpointOut = args["checkpoint-out"];
  const env = options.env || process.env;

  const result = await runAgentReview(sourceDraft, dslDraft, {
    provider: options.agentReviewProvider,
    providerOptions: options.agentReviewProviderOptions,
    reviewedAt: options.reviewedAt,
    batchSize: args["review-batch-size"],
    maxAttemptsPerAction: args["max-review-attempts"],
    checkpointSigningKey: options.agentReviewCheckpointKey || env.AGENT_REVIEW_CHECKPOINT_KEY,
    resumeCheckpoint,
    onCheckpoint: checkpointOut ? (checkpoint) => writeJsonAtomic(checkpointOut, checkpoint) : undefined
  });

  if (!result.ok) {
    if (args["report-out"]) writeJson(args["report-out"], result.report);
    printJson({
      ...result.report,
      reportWrote: args["report-out"],
      checkpointWrote: checkpointOut && result.checkpoint ? checkpointOut : undefined
    });
    process.exitCode = 1;
    return;
  }

  writeJson(args.out, result.dsl);
  if (args["report-out"]) writeJson(args["report-out"], result.report);
  printJson({
    ...result.report,
    wrote: args.out,
    reportWrote: args["report-out"],
    checkpointWrote: checkpointOut
  });
}

function runCheck(argv) {
  const [kind, ...rest] = argv;
  const args = parseArgs(rest);

  if (kind === "draft") {
    const inputPath = args.positionals[0];
    if (!inputPath) throw new Error("check draft requires a dsl-draft path");
    printJson(checkDraft(readJson(inputPath)));
    return;
  }

  if (kind === "trust") {
    const sourceDraftPath = args.positionals[0];
    const migrationDslPath = args.positionals[1];
    if (!sourceDraftPath || !migrationDslPath) {
      throw new Error("check trust requires <source-draft.json> <migration.dsl.json>");
    }
    printJson(checkTrust(readJson(sourceDraftPath), readJson(migrationDslPath)));
    return;
  }

  if (kind === "execute") {
    const inputPath = args.positionals[0];
    if (!inputPath) throw new Error("check execute requires a migration.dsl.json path");
    printJson(checkExecute(readJson(inputPath)));
    return;
  }

  throw new Error("check requires one of: draft, trust, execute");
}

function runValidate(argv) {
  const args = parseArgs(argv);
  const inputPath = args.positionals[0];
  if (!inputPath) throw new Error("validate requires a migration.dsl.json path");
  printJson(checkExecute(readJson(inputPath)));
}

function runDryRun(argv) {
  const args = parseArgs(argv);
  const inputPath = args.positionals[0];
  if (!inputPath) throw new Error("dry-run requires a trusted migration DSL path");
  const plan = buildDryRunPlan(readJson(inputPath));
  if (args.out) writeJson(args.out, plan);
  printJson(args.out ? { ...plan, wrote: args.out } : plan);
}

async function runExecute(argv, options = {}) {
  const args = parseArgs(argv);
  const inputPath = args.positionals[0];
  if (!inputPath) throw new Error("execute requires a trusted migration DSL path");
  const env = options.env || process.env;
  const execute = options.executeDsl || executeDsl;
  const report = await execute(readJson(inputPath), {
    confirmWrite: args["confirm-write"] === true,
    targetCategoryId: args["target-category-id"],
    targetTemplateId: args["target-template-id"],
    publishedFormPatch: args["published-form-patch"] === true,
    readonlyFieldIds: parseFdIdList(args["readonly-field"], "--readonly-field"),
    scriptActionIds: parseFdIdList(args["script-action"], "--script-action"),
    expectedSnapshotDigest: args["expected-snapshot-digest"],
    artifactsDir: args["artifacts-dir"],
    baseUrl: selectNewoaBaseUrl(args["base-url"], env.NEWOA_BASE_URL),
    fallbackFdIds: selectFallbackFdIds(env),
    participantOverrides: parseParticipantOverrides(args["participant-override"]),
    templateAuthorizationOverrides: parseTemplateAuthorizationOverrides(
      args["template-authorization-override"]
    ),
    directParticipantOverrides: parseDirectParticipantOverrides(
      args["direct-participant-override"]
    ),
    allowTemplateAuthorizationFallback:
      args["allow-template-authorization-fallback"] === true,
    allowMissingDirectPersonFallback: args["allow-missing-direct-person-fallback"] === true,
    allowMissingDirectPostFallback: args["allow-missing-direct-post-fallback"] === true,
    directPersonFallbackIds: parseFdIdList(
      args["direct-person-fallback-id"],
      "--direct-person-fallback-id"
    ),
    credentials: {
      username: env.NEWOA_USERNAME,
      encryptedPassword: env.NEWOA_ENCRYPTED_PASSWORD
    }
  });
  if (args.out) writeJson(args.out, report);
  printJson(args.out ? { ...report, wrote: args.out } : report);
  if (report.ok !== true) process.exitCode = 1;
}

async function runReconcileTransferRecord(argv, options = {}) {
  const args = parseArgs(argv);
  const inputPath = args.positionals[0];
  if (!inputPath) {
    throw new Error("reconcile-transfer-record requires a trusted migration DSL path");
  }
  if (typeof args.source !== "string" || !args.source.trim()) {
    throw new Error("reconcile-transfer-record requires --source <source-dir|sysform.xml>");
  }
  if (typeof args["prior-execution-report"] !== "string") {
    throw new Error("reconcile-transfer-record requires --prior-execution-report <report.json>");
  }
  const env = options.env || process.env;
  const reconcile = options.reconcileTransferRecord || reconcileTransferRecord;
  const sourceDraft = cleanSourceFile(args.source, {
    functionWhitelist: loadWhitelist(args),
    templateName: readTemplateNameOption(args),
    workflowReferenceDir: readWorkflowReferenceDirOption(args)
  });
  const report = await reconcile(readJson(inputPath), {
    sourceDraft,
    priorExecutionReport: readJson(args["prior-execution-report"]),
    confirmWrite: args["confirm-write"] === true,
    expectedDslDigest: args["expected-dsl-digest"],
    expectedPriorReportDigest: args["expected-prior-report-digest"],
    expectedEvidenceDigest: args["expected-evidence-digest"],
    artifactsDir: args["artifacts-dir"],
    targetCategoryId: args["target-category-id"],
    targetTemplateId: args["target-template-id"],
    baseUrl: selectNewoaBaseUrl(args["base-url"], env.NEWOA_BASE_URL),
    credentials: {
      username: env.NEWOA_USERNAME,
      encryptedPassword: env.NEWOA_ENCRYPTED_PASSWORD
    }
  });
  if (args.out) writeJson(args.out, report);
  printJson(args.out ? { ...report, wrote: args.out } : report);
  if (report.ok !== true) process.exitCode = 1;
}

async function runRepairLockedDraft(argv, options = {}) {
  const args = parseArgs(argv);
  const inputPath = args.positionals[0];
  if (!inputPath) throw new Error("repair-locked-draft requires a trusted migration DSL path");
  if (typeof args.source !== "string" || !args.source.trim()) {
    throw new Error("repair-locked-draft requires --source <source-dir|sysform.xml>");
  }
  if (typeof args["prior-execution-report"] !== "string") {
    throw new Error("repair-locked-draft requires --prior-execution-report <report.json>");
  }
  const env = options.env || process.env;
  const repair = options.repairLockedDraft || repairLockedDraft;
  const sourceDraft = cleanSourceFile(args.source, {
    functionWhitelist: loadWhitelist(args),
    templateName: readTemplateNameOption(args),
    workflowReferenceDir: readWorkflowReferenceDirOption(args)
  });
  const report = await repair(readJson(inputPath), {
    sourceDraft,
    priorDsl: typeof args["prior-migration-dsl"] === "string"
      ? readJson(args["prior-migration-dsl"])
      : undefined,
    priorExecutionReport: readJson(args["prior-execution-report"]),
    repairKind: args["repair-kind"],
    confirmWrite: args["confirm-write"] === true,
    expectedDslDigest: args["expected-dsl-digest"],
    expectedPriorDslDigest: args["expected-prior-dsl-digest"],
    expectedPriorReportDigest: args["expected-prior-report-digest"],
    expectedEvidenceDigest: args["expected-evidence-digest"],
    artifactsDir: args["artifacts-dir"],
    targetCategoryId: args["target-category-id"],
    targetTemplateId: args["target-template-id"],
    baseUrl: selectNewoaBaseUrl(args["base-url"], env.NEWOA_BASE_URL),
    fallbackFdIds: selectFallbackFdIds(env),
    credentials: {
      username: env.NEWOA_USERNAME,
      encryptedPassword: env.NEWOA_ENCRYPTED_PASSWORD
    }
  });
  if (args.out) writeJson(args.out, report);
  printJson(args.out ? { ...report, wrote: args.out } : report);
  if (report.ok !== true) process.exitCode = 1;
}

function loadWhitelist(args) {
  return loadFunctionWhitelist(args["function-whitelist"] || process.env.MK_FUNCTION_WHITELIST_PATH);
}

function readTemplateNameOption(args) {
  const value = args["template-name"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("--template-name requires a non-empty value");
  }
  return value.trim();
}

function readWorkflowReferenceDirOption(args) {
  const value = args["workflow-reference-dir"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("--workflow-reference-dir requires a non-empty directory path");
  }
  return value.trim();
}

function writeOrPrint(args, artifact, output) {
  if (args.out) {
    writeJson(args.out, artifact);
    printJson({ ...output, wrote: args.out });
    return;
  }
  printJson(output);
}

function parseArgs(argv) {
  const result = { positionals: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      result.positionals.push(value);
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }

    if (
      [
        "participant-override",
        "template-authorization-override",
        "direct-participant-override",
        "direct-person-fallback-id",
        "readonly-field",
        "script-action"
      ].includes(key) &&
      Object.hasOwn(result, key)
    ) {
      result[key] = Array.isArray(result[key])
        ? [...result[key], next]
        : [result[key], next];
    } else {
      result[key] = next;
    }
    index += 1;
  }

  return result;
}

function parseParticipantOverrides(value) {
  return parseOverridePairs(value, {
    optionName: "--participant-override",
    sourceKey: "sourceId"
  });
}

function parseTemplateAuthorizationOverrides(value) {
  return parseOverridePairs(value, {
    optionName: "--template-authorization-override",
    sourceKey: "sourceId"
  });
}

function parseDirectParticipantOverrides(value) {
  return parseOverridePairs(value, {
    optionName: "--direct-participant-override",
    sourceKey: "sourceTargetId"
  });
}

function parseOverridePairs(value, { optionName, sourceKey }) {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  const requirement = `${optionName} requires <${sourceKey}>=<targetFdId>`;
  const overrides = values.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error(requirement);
    }
    const separatorIndex = entry.indexOf("=");
    const lastSeparatorIndex = entry.lastIndexOf("=");
    const sourceValue = separatorIndex >= 0 ? entry.slice(0, separatorIndex).trim() : "";
    const targetFdId = separatorIndex >= 0 ? entry.slice(separatorIndex + 1).trim() : "";
    if (!sourceValue || !targetFdId || separatorIndex !== lastSeparatorIndex) {
      throw new Error(requirement);
    }
    return { [sourceKey]: sourceValue, targetFdId };
  });
  const sourceValues = new Set();
  for (const override of overrides) {
    if (sourceValues.has(override[sourceKey])) {
      throw new Error(
        `${optionName} ${sourceKey} may be specified only once: ${override[sourceKey]}`
      );
    }
    sourceValues.add(override[sourceKey]);
  }
  return overrides;
}

function parseFdIdList(value, optionName) {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${optionName} requires a non-empty fdId`);
    }
    return entry.trim();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${optionName} may specify each fdId only once`);
  }
  return normalized;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printUsage() {
  console.error("Usage:");
  console.error("  node src/cli/main.js clean <source-dir|sysform.xml> [--template-name <original-name>] [--workflow-reference-dir <initdata-dir>] [--out source-draft.json]");
  console.error("  node src/cli/main.js draft <source-draft.json> [--out dsl-draft.json]");
  console.error("  node src/cli/main.js translate <source-dir|sysform.xml> [--template-name <original-name>] [--workflow-reference-dir <initdata-dir>] [--out dsl-draft.json]");
  console.error("  OPENAI_BASE_URL=... OPENAI_API_KEY=... OPENAI_MODEL=... AGENT_REVIEW_CHECKPOINT_KEY=... node src/cli/main.js agent-review <source-draft.json> <dsl-draft.json> --out migration.dsl.json [--report-out agent-review.report.json] [--checkpoint-out agent-review.checkpoint.json] [--resume-from agent-review.checkpoint.json] [--review-batch-size 12] [--max-review-attempts 2]");
  console.error("    Review and repair use OPENAI_MODEL from the environment; no model fallback.");
  console.error("  node src/cli/main.js trust <source-draft.json> <dsl-draft.json> --external-agent-reviewed [--reviewer-name name] [--out migration.dsl.json]");
  console.error("  node src/cli/main.js check draft <dsl-draft.json>");
  console.error("  node src/cli/main.js check trust <source-draft.json> <migration.dsl.json>");
  console.error("  node src/cli/main.js check execute <migration.dsl.json>");
  console.error("  node src/cli/main.js dry-run <migration.dsl.json> [--out report.json]");
  console.error("  NEWOA_BASE_URL=... NEWOA_USERNAME=... NEWOA_ENCRYPTED_PASSWORD=... node src/cli/main.js reconcile-transfer-record <migration.dsl.json> --source <source-dir|sysform.xml> --prior-execution-report <readback-failed-report.json> --expected-dsl-digest <sha256> --expected-prior-report-digest <sha256> --target-category-id <fdId> --target-template-id <MK_TEST_fdId> [--confirm-write --expected-evidence-digest <sha256> --artifacts-dir <new-directory>] [--base-url <origin>] [--out report.json]");
  console.error("  NEWOA_BASE_URL=... NEWOA_USERNAME=... NEWOA_ENCRYPTED_PASSWORD=... node src/cli/main.js repair-locked-draft <migration.dsl.json> --source <source-dir|sysform.xml> --prior-execution-report <readback-failed-report.json> --repair-kind <template_authorization|calculation> --expected-dsl-digest <sha256> --expected-prior-report-digest <sha256> --target-category-id <fdId> --target-template-id <MK_TEST_fdId> [--prior-migration-dsl <historical.dsl.json> --expected-prior-dsl-digest <sha256>] [--confirm-write --expected-evidence-digest <sha256> --artifacts-dir <new-directory>] [--base-url <origin>] [--out report.json]");
  console.error("  NEWOA_BASE_URL=... NEWOA_USERNAME=... NEWOA_ENCRYPTED_PASSWORD=... NEWOA_FALLBACK_PERSON_FD_ID=... NEWOA_FALLBACK_ORGANIZATION_FD_ID=... NEWOA_FALLBACK_GROUP_FD_ID=... NEWOA_FALLBACK_POST_FD_ID=... node src/cli/main.js execute <migration.dsl.json> --confirm-write --target-category-id <fdId> [--allow-template-authorization-fallback] [--allow-missing-direct-person-fallback] [--allow-missing-direct-post-fallback] [--direct-person-fallback-id <sourceFdId>]... [--participant-override <sourceId>=<targetFdId>]... [--template-authorization-override <sourceId>=<targetFdId>]... [--direct-participant-override <sourceTargetId>=<targetFdId>]... [--target-template-id <MK_TEST_fdId>] [--base-url <origin>]");
  console.error("    Published form repair additionally requires --published-form-patch --target-template-id <fdId> --expected-snapshot-digest <sha256> --artifacts-dir <new-directory> [--readonly-field <id>]... [--script-action <id>]...");
}

if (isDirectInvocation()) {
  await startCli(process.argv.slice(2));
}

export function isDirectInvocation(entryPath = process.argv[1]) {
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
