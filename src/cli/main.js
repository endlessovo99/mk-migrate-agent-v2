#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { checkDraft, checkExecute } from "../dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../dsl/trust.js";
import { buildDryRunPlan } from "../executor/dry-run.js";
import { executeDsl } from "../executor/execute.js";
import { loadFunctionWhitelist } from "../translator/function-whitelist.js";
import { cleanSourceFile, draftSourceDraft, translateSourceFile } from "../translator/index.js";

const commands = new Map([
  ["clean", runClean],
  ["draft", runDraft],
  ["translate", runTranslate],
  ["trust", runTrust],
  ["check", runCheck],
  ["validate", runValidate],
  ["dry-run", runDryRun],
  ["execute", runExecute]
]);

export async function main(argv = []) {
  const [commandName, ...rest] = argv;
  const command = commands.get(commandName);

  if (!command) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  try {
    await command(rest);
  } catch (error) {
    process.exitCode = 1;
    printJson({
      ok: false,
      status: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function runClean(argv) {
  const args = parseArgs(argv);
  const sourcePath = args.positionals[0];
  if (!sourcePath) throw new Error("clean requires a source path");

  const sourceDraft = cleanSourceFile(sourcePath, {
    functionWhitelist: loadWhitelist(args)
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
    functionWhitelist: loadWhitelist(args)
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

async function runExecute(argv) {
  const args = parseArgs(argv);
  const inputPath = args.positionals[0];
  if (!inputPath) throw new Error("execute requires a trusted migration DSL path");
  const report = await executeDsl(readJson(inputPath), {
    confirmWrite: args["confirm-write"] === true,
    targetCategoryId: args["target-category-id"],
    baseUrl: args["base-url"]
  });
  if (args.out) writeJson(args.out, report);
  printJson(args.out ? { ...report, wrote: args.out } : report);
}

function loadWhitelist(args) {
  return loadFunctionWhitelist(args["function-whitelist"] || process.env.MK_FUNCTION_WHITELIST_PATH);
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

    result[key] = next;
    index += 1;
  }

  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printUsage() {
  console.error("Usage:");
  console.error("  node src/cli/main.js clean <source-dir|sysform.xml> [--out source-draft.json]");
  console.error("  node src/cli/main.js draft <source-draft.json> [--out dsl-draft.json]");
  console.error("  node src/cli/main.js translate <source-dir|sysform.xml> [--out dsl-draft.json]");
  console.error("  node src/cli/main.js trust <source-draft.json> <dsl-draft.json> --external-agent-reviewed [--reviewer-name name] [--out migration.dsl.json]");
  console.error("  node src/cli/main.js check draft <dsl-draft.json>");
  console.error("  node src/cli/main.js check trust <source-draft.json> <migration.dsl.json>");
  console.error("  node src/cli/main.js check execute <migration.dsl.json>");
  console.error("  node src/cli/main.js dry-run <migration.dsl.json> [--out report.json]");
  console.error("  NEWOA_USERNAME=... NEWOA_ENCRYPTED_PASSWORD=... node src/cli/main.js execute <migration.dsl.json> --confirm-write --target-category-id <fdId>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
