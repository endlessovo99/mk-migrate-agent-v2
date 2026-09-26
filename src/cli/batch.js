import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";
import { PostgresBatchStore } from "../batch/store.js";
import { createBatch } from "../batch/intake.js";
import { approveBatch, executeBatch, inspectBatch, prepareBatch } from "../batch/service.js";
import { recoverBatch, retryItem, setBatchStatus, setTargetLimit } from "../batch/scheduler.js";
import { createRepair, previewRepair, applyRepair } from "../batch/repairs.js";
import { createScopedRepair, previewScopedRepair, applyScopedRepair } from "../batch/scoped-repairs.js";
import { requireValue } from "../batch/contracts.js";

/** Batch credentials enter here, never through manifests or repair records. */
export async function runBatchCommand(argv, options = {}) {
  const args = parse(argv);
  const env = options.env || process.env;
  requireValue(options.batchStore || env.MK_BATCH_DATABASE_URL, "Set MK_BATCH_DATABASE_URL for persistent batch state");
  const store = options.batchStore || new PostgresBatchStore(new Pool({ connectionString: env.MK_BATCH_DATABASE_URL }));
  try {
    await store.init();
    const result = await dispatch(store, args, { ...options, env });
    if (args.out) {
      mkdirSync(dirname(resolve(args.out)), { recursive: true, mode: 0o700 });
      writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      console.log(JSON.stringify({ wrote: resolve(args.out), id: result?.id || result?.batch?.id || null }, null, 2));
    } else console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { if (!options.batchStore) await store.close(); }
}

async function dispatch(store, args, options) {
  const [command, id, secondary] = args.positionals;
  const arity = { create: 1, list: 0, prepare: 1, status: 1, approve: 1, run: 1, pause: 1, resume: 1,
    recover: 1, retry: 2, limit: 2, item: 1, "repair-create": 1, repairs: 0, "repair-show": 1,
    "repair-history": 0, "repair-preview": 1, "repair-apply": 1 };
  requireValue(Object.hasOwn(arity, command) && args.positionals.length === arity[command] + 1,
    "Unknown batch command or unexpected positional arguments");
  const actor = args.actor;
  const credentials = { username: options.env.NEWOA_USERNAME, encryptedPassword: options.env.NEWOA_ENCRYPTED_PASSWORD };
  const workerOptions = { env: options.env, concurrency: args.concurrency, leaseMs: args["lease-ms"],
    requestTimeoutMs: args["request-timeout-ms"], provider: options.agentReviewProvider,
    clientFactory: options.batchClientFactory, review: options.batchReview, execute: options.batchExecute,
    confirmWrite: args["confirm-write"] === true, credentials };
  if (command === "create") return createBatch(store, readJson(id), { relativeTo: dirname(resolve(id)) });
  if (command === "list") return store.list("batch");
  if (command === "prepare") return prepareBatch(store, id, workerOptions);
  if (command === "status") return inspectBatch(store, id);
  if (command === "approve") return approveBatch(store, id, { expectedDigest: args["expected-digest"], confirmWrite: args["confirm-write"] === true, actor });
  if (command === "run") return executeBatch(store, id, workerOptions);
  if (command === "pause" || command === "resume") return setBatchStatus(store, id, command === "pause" ? "paused" : "running");
  if (command === "recover") return recoverBatch(store, id);
  if (command === "retry") return retryItem(store, id, secondary);
  if (command === "limit") return setTargetLimit(store, id, secondary, actor);
  if (command === "item") {
    const item = await store.get("item", id);
    requireValue(item, "Item not found");
    return item;
  }
  if (command === "repair-create") {
    const definition = readJson(id);
    return isScoped(definition) ? createScopedRepair(store, definition) : createRepair(store, definition);
  }
  if (command === "repairs") return store.list("repair");
  if (command === "repair-show") return store.get("repair", id);
  if (command === "repair-history") return store.list("repair_application", args.item ? { itemId: args.item } : args.batch ? { batchId: args.batch } : {});
  if (command === "repair-preview") {
    const repair = await store.get("repair", id);
    requireValue(repair, "Repair not found");
    const previewOptions = { batchId: args.batch, itemIds: args.items ? args.items.split(",") : undefined,
      credentials, clientFactory: options.batchClientFactory,
      ...(args.replacements ? { replacements: readJson(args.replacements) } : {}) };
    return isScoped(repair.definition) ? previewScopedRepair(store, id, previewOptions) : previewRepair(store, id, previewOptions);
  }
  if (command === "repair-apply") {
    const preview = await store.get("repair_run", id);
    requireValue(preview, "Repair preview not found");
    const repair = await store.get("repair", preview.repairId);
    const applyOptions = { expectedDigest: args["expected-digest"], actor,
      confirmApply: args["confirm-apply"] === true, confirmWrite: args["confirm-write"] === true,
      credentials, clientFactory: options.batchClientFactory, artifactsRoot: args["artifacts-root"] };
    return isScoped(repair.definition) ? applyScopedRepair(store, id, applyOptions) : applyRepair(store, id, applyOptions);
  }
  throw new Error("batch commands: create, list, prepare, status, approve, run, pause, resume, recover, retry, item, repair-create, repairs, repair-show, repair-preview, repair-apply, repair-history");
}

function isScoped(definition) { return ["locked_draft", "reconcile_transfer_record"].includes(definition?.action?.kind); }
function readJson(path) { requireValue(typeof path === "string" && path.length > 0, "JSON input file is required"); return JSON.parse(readFileSync(path, "utf8")); }
function parse(argv) {
  const args = { positionals: [] };
  const boolean = new Set(["confirm-write", "confirm-apply"]);
  const value = new Set(["out", "actor", "concurrency", "lease-ms", "request-timeout-ms", "expected-digest", "batch", "item", "items", "replacements", "artifacts-root"]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) { args.positionals.push(token); continue; }
    const key = token.slice(2);
    requireValue(boolean.has(key) || value.has(key), `Unknown batch option: ${token}`);
    requireValue(!(key in args), `Duplicate batch option: ${token}`);
    if (boolean.has(key)) args[key] = true;
    else {
      requireValue(argv[index + 1] && !argv[index + 1].startsWith("--"), `Missing value for ${token}`);
      args[key] = argv[++index];
    }
  }
  return args;
}
