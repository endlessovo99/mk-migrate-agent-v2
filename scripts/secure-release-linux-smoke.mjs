// Opt-in integration test. Run only inside a disposable Linux root environment.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { packageRelease } from "../tools/secure-release/package.mjs";
import { unlockRelease } from "../tools/secure-release/unlock-local.mjs";
import { command, sha256 } from "../tools/secure-release/common.mjs";
import { findRouteCase } from "../tests/route-validation/manifest.js";
import { resolveRouteFixture } from "../tests/route-validation/fixture.js";
import { createFakeReviewProvider } from "../tests/route-validation/fake-review-provider.js";
import { FakeNewoaAdapter } from "../tests/route-validation/fake-newoa-adapter.js";
import { withNetworkGuard } from "../tests/route-validation/network-guard.js";

assert.equal(process.env.MK_SECURE_LINUX_SMOKE, "1", "Explicit opt-in is required");
assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 0);
const root = fileURLToPath(new URL("../", import.meta.url));
const server = join(root, "tools/secure-release/server.mjs");
const dir = mkdtempSync("/var/tmp/mk-secure-smoke-");
const runtime = `/run/mk-secure-smoke-${process.pid}`;
const data = join(dir, "server-data");
const config = join(dir, "newoa.env");
const flags = ["--runtime", runtime, "--data", data, "--config", config];
const layeredArgs = (action, args = []) => [
  "--mount", "--propagation", "private", "sh", "-c",
  'mount --rbind "$1" "$1" && shift && exec "$@"',
  "mk-layered-mount-fixture", runtime, process.execPath, server, action, ...flags, ...args
];
const results = [];
const passed = (name) => { results.push(name); console.log(`PASS ${name}`); };
const invoke = (action, args = [], options = {}) => spawnSync(process.execPath, [server, action, ...flags, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024, ...options });
function good(action, args = [], options = {}) {
  const result = invoke(action, args, options);
  assert.equal(result.status, 0, `${action}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
let persistentLock;
let activeChild;
let activeDone;
try {
  const release = packageRelease({ root, out: join(dir, "local-release") });
  const encrypted = join(release.uploadDirectory, "engine.mkpkg.age");
  const key = readFileSync(join(dir, "local-release/private/unlock.key"));
  const unlockArgs = ["--package", encrypted, "--sha256", release.sha256];
  assert.equal(good("status").status, "locked");
  assert.notEqual(invoke("run", ["--", "clean", "input.xml"]).status, 0);
  passed("locked runtime cannot execute");

  const otherKey = command("age-keygen", []);
  assert.notEqual(invoke("unlock", unlockArgs, { input: otherKey }).status, 0);
  otherKey.fill(0);
  assert.equal(good("status").status, "locked");
  assert.deepEqual(readdirSync(runtime), []);
  passed("wrong key cleans up tmpfs without a plaintext disk fallback");

  const damaged = readFileSync(encrypted);
  damaged[damaged.length - 1] ^= 1;
  const damagedPath = join(dir, "damaged.age");
  writeFileSync(damagedPath, damaged);
  assert.notEqual(invoke("unlock", ["--package", damagedPath, "--sha256", release.sha256], { input: key }).status, 0);
  assert.notEqual(invoke("unlock", ["--package", damagedPath, "--sha256", sha256(damaged)], { input: key }).status, 0);
  assert.equal(good("status").status, "locked");
  assert.deepEqual(readdirSync(runtime), []);
  passed("digest mismatch and authenticated ciphertext corruption are rejected");

  const fakeBin = join(dir, "fault-injection");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "mount"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  assert.notEqual(invoke("unlock", unlockArgs, { input: key, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } }).status, 0);
  assert.deepEqual(readdirSync(runtime), []);
  passed("mount failure never writes source into the ordinary directory");

  assert.equal(good("unlock", unlockArgs, { input: key }).releaseId, release.releaseId);
  key.fill(0);
  assert.throws(() => writeFileSync(join(runtime, "accidental-output"), "blocked"), /EROFS/);
  assert.equal(good("status").sha256, release.sha256);
  passed("real age unlock installs dependencies and makes tmpfs read-only");

  mkdirSync(join(data, "input"), { recursive: true });
  writeFileSync(config, "SECURE_RELEASE_SMOKE=1\n", { mode: 0o600 });
  const route = findRouteCase("form-only-success");
  const input = join(data, "input/flow_SysFormTemplate.xml");
  cpSync(resolveRouteFixture(route.source), input);
  const xml = readFileSync(input);
  good("run", ["--", "clean", "input/flow_SysFormTemplate.xml", "--out", "dsl/source-draft.json"]);
  good("run", ["--", "draft", "dsl/source-draft.json", "--out", "dsl/dsl-draft.json"]);
  const imported = (path) => import(pathToFileURL(join(runtime, "src", path)).href);
  await withNetworkGuard(async () => {
    const { runAgentReview } = await imported("agent-review/index.js");
    const { executeDsl } = await imported("executor/execute.js");
    const reviewed = await runAgentReview(
      JSON.parse(readFileSync(join(data, "dsl/source-draft.json"))),
      JSON.parse(readFileSync(join(data, "dsl/dsl-draft.json"))),
      { provider: createFakeReviewProvider("accept"), reviewedAt: "2026-10-10T00:00:00.000Z" }
    );
    assert.equal(reviewed.ok, true);
    writeFileSync(join(data, "dsl/migration.dsl.json"), JSON.stringify(reviewed.dsl));
    const report = await executeDsl(reviewed.dsl, {
      client: new FakeNewoaAdapter("persist", { templateAuthorization: reviewed.dsl.template.authorization }),
      confirmWrite: true, targetCategoryId: "route-category-id", baseUrl: "https://p-sit.onewo.com",
      credentials: { username: "fixture-user", encryptedPassword: "fixture-password" },
      now: new Date("2026-10-10T00:00:00.000Z"), transferRecordIdFactory: () => "secure-linux-smoke-record"
    });
    assert.equal(report.ok, true);
    writeFileSync(join(data, "reports/execution.report.json"), JSON.stringify(report));
  });
  good("run", ["--", "check", "execute", "dsl/migration.dsl.json"]);
  good("run", ["--", "dry-run", "dsl/migration.dsl.json", "--out", "reports/dry-run.json"]);
  const { engineDigest } = await imported("batch/contracts.js");
  const originalDigest = (await import("../src/batch/contracts.js")).engineDigest();
  assert.equal(engineDigest(), originalDigest);
  const { createLockedDraftState } = await imported("executor/locked-draft-state.js");
  persistentLock = createLockedDraftState({ baseUrl: "https://example.test", targetTemplateId: `secure-smoke-${process.pid}`, operation: "fixture", evidenceDigest: "fixture", artifactsDir: join(data, "reports/repair-fixture") }).globalPath;
  assert.deepEqual(readFileSync(input), xml);
  passed("plaintext XML/DSL, external config, fake execution and engine digest remain compatible");

  const layeredRun = spawnSync("unshare", layeredArgs("run", ["--", "check", "execute", "dsl/migration.dsl.json"]), { encoding: "utf8" });
  assert.equal(layeredRun.status, 0, layeredRun.stderr);
  assert.equal(JSON.parse(layeredRun.stdout).ok, true);
  passed("the regular launcher runs in a namespace with duplicate readonly mount entries");

  const layeredLock = spawnSync("unshare", layeredArgs("lock"), { encoding: "utf8" });
  assert.notEqual(layeredLock.status, 0);
  assert.match(layeredLock.stderr, /ordinary server terminal/);
  assert.equal(good("status").status, "unlocked");
  passed("sandbox lifecycle commands cannot unmount one layer and falsely report a locked runtime");

  const shadowedArgs = (source, action, args = []) => [
    "--mount", "--propagation", "private", "sh", "-c",
    'mount -t tmpfs -o size=8m,mode=0700 "$1" "$2" && printf \'%s\\n\' \'{"status":"unlocked"}\' > "$2/.release-ready.json" && shift 2 && exec "$@"',
    "mk-shadowed-mount-fixture", source, runtime, process.execPath, server, action, ...flags, ...args
  ];
  const foreign = spawnSync("unshare", shadowedArgs("foreign-source", "status"), { encoding: "utf8" });
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /not owned by this launcher/);
  const writable = spawnSync("unshare", shadowedArgs("mk-migrate-secure", "status"), { encoding: "utf8" });
  assert.equal(writable.status, 0, writable.stderr);
  assert.equal(JSON.parse(writable.stdout).status, "incomplete");
  const writableRun = spawnSync("unshare", shadowedArgs("mk-migrate-secure", "run", ["--", "check", "execute", "dsl/migration.dsl.json"]), { encoding: "utf8" });
  assert.notEqual(writableRun.status, 0);
  assert.match(writableRun.stderr, /locked or incomplete/);
  passed("a valid hidden mount cannot authorize a foreign or writable visible mount");

  const fifo = join(data, "input/held_SysFormTemplate.xml");
  command("mkfifo", [fifo]);
  const running = spawn("unshare", layeredArgs("run", ["--", "clean", "input/held_SysFormTemplate.xml", "--out", "dsl/held.json"]), { stdio: ["ignore", "ignore", "pipe"] });
  const completed = new Promise((resolve, reject) => { running.on("error", reject); running.on("exit", (code) => resolve(code)); });
  activeChild = running;
  activeDone = completed;
  let busy = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const probe = spawnSync("flock", ["--nonblock", "--exclusive", `${runtime}.control.lock`, "true"]);
    if (probe.status === 1) { busy = true; break; }
    await delay(20);
  }
  assert.equal(busy, true);
  assert.equal(invoke("lock").status, 75);
  assert.equal(invoke("unlock", unlockArgs, { input: "unused" }).status, 75);
  assert.equal(good("status").status, "unlocked");
  writeFileSync(fifo, xml);
  assert.equal(await completed, 0);
  activeChild = null;
  rmSync(fifo);
  passed("an active sandbox CLI command holds the shared lock across mount namespaces");

  const backup = join(dir, "server-backup");
  mkdirSync(backup);
  cpSync(data, join(backup, "data"), { recursive: true });
  cpSync(release.uploadDirectory, join(backup, "release"), { recursive: true });
  cpSync(persistentLock, join(backup, "permanent-attempt-lock.json"));
  assert.equal(good("lock").status, "locked");
  assert.deepEqual(readdirSync(runtime), []);
  assert.ok(existsSync(persistentLock));
  assert.equal(JSON.parse(readFileSync(join(data, "dsl/migration.dsl.json"))).trust.executable, true);
  assert.equal(JSON.parse(readFileSync(join(backup, "data/reports/execution.report.json"))).ok, true);
  assert.ok(!existsSync(join(backup, "release/private")) && !existsSync(join(backup, "release/src")));
  const restored = join(dir, "restored-data");
  cpSync(join(backup, "data"), restored, { recursive: true });
  const restoredRun = spawnSync(process.execPath, [server, "run", "--runtime", `${runtime}-restored`, "--data", restored, "--", "check", "execute", "dsl/migration.dsl.json"]);
  assert.notEqual(restoredRun.status, 0);
  passed("lock preserves XML/DSL/receipts/permanent locks; disk-backup restore cannot run without unlock");

  if (process.env.MK_SECURE_SSH_HOST) {
    const fresh = packageRelease({ root, out: join(dir, "fresh-local-release") });
    const receipt = unlockRelease({ release: fresh.directory, host: process.env.MK_SECURE_SSH_HOST, "remote-launcher": server, "remote-package": join(fresh.uploadDirectory, "engine.mkpkg.age"), runtime, data, config });
    assert.equal(receipt.localKeyRemoved, true);
    assert.ok(!existsSync(join(fresh.directory, "private/unlock.key")));
    assert.equal(good("status").releaseId, fresh.releaseId);
    good("lock");
    passed("real SSH pipe unlock returns a matching receipt and removes the local one-use key");
  }
  console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2));
} finally {
  if (activeChild) { activeChild.kill("SIGTERM"); await activeDone; }
  assert.equal(invoke("lock").status, 0, "Cleanup failed: inspect the retained test runtime before removing anything");
  rmSync(dir, { recursive: true, force: true });
  if (persistentLock) rmSync(persistentLock, { force: true });
  for (const path of [runtime, `${runtime}.control.lock`, `${runtime}-restored.control.lock`]) rmSync(path, { force: true, recursive: true });
}
