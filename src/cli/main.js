#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateMigrationDsl } from "../dsl/schema.js";
import { buildDryRunPlan } from "../executor/dry-run.js";
import { executeDsl } from "../executor/execute.js";
import { translateSourceFile } from "../translator/index.js";

const commands = new Map([
  ["translate", runTranslate],
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

function runTranslate(argv) {
  const args = parseArgs(argv);
  const sourcePath = args.positionals[0];
  if (!sourcePath) throw new Error("translate requires a source path");

  const dsl = translateSourceFile(sourcePath);
  const validation = validateMigrationDsl(dsl);
  const output = {
    ok: validation.ok,
    status: validation.status,
    diagnostics: validation.diagnostics,
    dsl
  };

  if (args.out) {
    writeJson(args.out, dsl);
    printJson({ ...output, wrote: args.out });
    return;
  }

  printJson(output);
}

function runValidate(argv) {
  const args = parseArgs(argv);
  const inputPath = args.positionals[0];
  if (!inputPath) throw new Error("validate requires a DSL path");
  printJson(validateMigrationDsl(readJson(inputPath)));
}

function runDryRun(argv) {
  const args = parseArgs(argv);
  const inputPath = args.positionals[0];
  if (!inputPath) throw new Error("dry-run requires a DSL path");
  printJson(buildDryRunPlan(readJson(inputPath)));
}

async function runExecute(argv) {
  const args = parseArgs(argv);
  const inputPath = args.positionals[0];
  if (!inputPath) throw new Error("execute requires a DSL path");
  printJson(await executeDsl(readJson(inputPath), {
    confirmWrite: args["confirm-write"] === true
  }));
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
  console.error("  node src/cli/main.js translate <source.json> [--out dsl.json]");
  console.error("  node src/cli/main.js validate <dsl.json>");
  console.error("  node src/cli/main.js dry-run <dsl.json>");
  console.error("  node src/cli/main.js execute <dsl.json> --confirm-write");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
