// Opt-in file-handoff test, requiring only a disposable Linux root environment.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { packageRelease } from "../tools/secure-release/package.mjs";
import { authorizeOffline, completeOffline } from "../tools/secure-release/offline-local.mjs";
import { command, sha256 } from "../tools/secure-release/common.mjs";
import { HANDOFF_KEY, HANDOFF_REQUEST } from "../tools/secure-release/offline-common.mjs";
import { findRouteCase } from "../tests/route-validation/manifest.js";
import { resolveRouteFixture } from "../tests/route-validation/fixture.js";

assert.equal(process.env.MK_SECURE_LINUX_SMOKE, "1");
assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 0);
const root = fileURLToPath(new URL("../", import.meta.url));
const server = join(root, "tools/secure-release/server.mjs");
const dir = mkdtempSync("/var/tmp/mk-offline-smoke-");
const disk = join(dir, "server-disk");
const data = join(disk, "data");
const runtime = `/run/mk-offline-smoke-${process.pid}`;
mkdirSync(disk);
const flags = ["--runtime", runtime, "--data", data];
const invoke = (action, args = []) => spawnSync(process.execPath, [server, action, ...flags, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 });
const good = (action, args = []) => {
  const result = invoke(action, args);
  assert.equal(result.status, 0, `${action}: ${result.stderr}`);
  return JSON.parse(result.stdout);
};
const results = [];
const passed = (name) => { results.push(name); console.log(`PASS ${name}`); };
try {
  const release = packageRelease({ root, out: join(dir, "local-release") });
  const encrypted = join(disk, "engine.mkpkg.age");
  cpSync(join(release.uploadDirectory, "engine.mkpkg.age"), encrypted);
  let attempt = 0;
  function prepare() {
    const path = join(disk, `request-${++attempt}.json`);
    const response = good("prepare-unlock", ["--package", encrypted, "--sha256", release.sha256, "--request-out", path]);
    assert.equal(response.status, "awaiting-ticket");
    assert.equal(response.requestSha256, sha256(readFileSync(path)));
    assert.equal(good("status").status, "awaiting-ticket");
    const downloaded = join(dir, `downloaded-request-${attempt}.json`);
    cpSync(path, downloaded);
    return { ...response, downloaded };
  }
  function authorize(request) {
    const ticket = authorizeOffline({ release: release.directory, request: request.downloaded, "request-sha256": request.requestSha256 });
    const path = join(disk, `ticket-${attempt}.age`);
    cpSync(ticket.ticketFile, path);
    assert.equal(readFileSync(path).includes(Buffer.from("AGE-SECRET-KEY")), false);
    assert.ok(existsSync(join(release.directory, "private/unlock.key")));
    return path;
  }
  const first = prepare();
  assert.ok(existsSync(join(runtime, HANDOFF_KEY)));
  assert.equal(readFileSync(first.downloaded).includes(Buffer.from("AGE-SECRET-KEY")), false);
  assert.notEqual(invoke("run", ["--", "clean", "input.xml"]).status, 0);
  const firstTicket = authorize(first);
  passed("public request and encrypted ticket move as files while runtime remains locked");
  good("lock");
  assert.deepEqual(readdirSync(runtime), []);
  prepare();
  assert.notEqual(invoke("unlock-ticket", ["--ticket", firstTicket, "--receipt-out", join(disk, "wrong-session-receipt.json")]).status, 0);
  assert.equal(good("status").status, "locked");
  passed("an old ticket cannot unlock a fresh memory session");

  const expiring = prepare();
  const expiredTicket = authorize(expiring);
  command("mount", ["-o", "remount,rw", runtime]);
  const pending = JSON.parse(readFileSync(join(runtime, HANDOFF_REQUEST)));
  pending.expiresAt = 1;
  writeFileSync(join(runtime, HANDOFF_REQUEST), JSON.stringify(pending));
  command("mount", ["-o", "remount,ro", runtime]);
  assert.equal(good("status").status, "expired-ticket");
  assert.notEqual(invoke("unlock-ticket", ["--ticket", expiredTicket, "--receipt-out", join(disk, "expired-receipt.json")]).status, 0);
  assert.equal(good("status").status, "locked");
  passed("expired authorization is rejected and its temporary key is cleared");

  const corrupted = prepare();
  const corruptTicket = authorize(corrupted);
  const altered = readFileSync(corruptTicket);
  altered[altered.length - 1] ^= 1;
  writeFileSync(corruptTicket, altered);
  assert.notEqual(invoke("unlock-ticket", ["--ticket", corruptTicket, "--receipt-out", join(disk, "corrupt-receipt.json")]).status, 0);
  assert.equal(good("status").status, "locked");
  assert.ok(existsSync(join(release.directory, "private/unlock.key")));
  passed("tampered tickets fail closed without deleting the local project key");

  const request = prepare();
  const ticket = authorize(request);
  const receiptPath = join(disk, "unlock-receipt.json");
  const receipt = good("unlock-ticket", ["--ticket", ticket, "--receipt-out", receiptPath]);
  assert.equal(receipt.status, "unlocked");
  assert.equal(receipt.releaseId, release.releaseId);
  assert.equal(receipt.requestId, request.requestId);
  assert.equal(good("status").proof, receipt.proof);
  assert.ok(!existsSync(join(runtime, HANDOFF_KEY)) && !existsSync(join(runtime, HANDOFF_REQUEST)));
  assert.throws(() => writeFileSync(join(runtime, "probe"), "blocked"), /EROFS/);
  assert.notEqual(invoke("unlock-ticket", ["--ticket", ticket, "--receipt-out", join(disk, "replayed-receipt.json")]).status, 0);
  assert.equal(good("status").status, "unlocked");
  passed("file-only activation consumes the session key and makes the engine read-only");

  mkdirSync(join(data, "input"), { recursive: true });
  cpSync(resolveRouteFixture(findRouteCase("form-only-success").source), join(data, "input/flow_SysFormTemplate.xml"));
  good("run", ["--", "clean", "input/flow_SysFormTemplate.xml", "--out", "dsl/source-draft.json"]);
  good("run", ["--", "draft", "dsl/source-draft.json", "--out", "dsl/dsl-draft.json"]);
  passed("the activated engine reads plaintext XML and writes plaintext DSL");

  const downloadedReceipt = join(dir, "downloaded-receipt.json");
  cpSync(receiptPath, downloadedReceipt);
  const forged = join(dir, "forged-receipt.json");
  writeFileSync(forged, JSON.stringify({ ...receipt, proof: "0".repeat(64) }));
  assert.throws(() => completeOffline({ release: release.directory, receipt: forged }), /proof mismatch/);
  assert.ok(existsSync(join(release.directory, "private/unlock.key")));
  assert.equal(completeOffline({ release: release.directory, receipt: downloadedReceipt }).localKeyRemoved, true);
  assert.ok(!existsSync(join(release.directory, "private/unlock.key")));
  passed("only an authentic downloaded receipt permits local key removal");

  good("lock");
  assert.deepEqual(readdirSync(runtime), []);
  assert.ok(existsSync(join(data, "dsl/dsl-draft.json")));
  assert.notEqual(invoke("unlock-ticket", ["--ticket", ticket, "--receipt-out", join(disk, "after-lock-receipt.json")]).status, 0);
  for (const name of readdirSync(disk)) {
    if (name === "data") continue;
    assert.equal(readFileSync(join(disk, name)).includes(Buffer.from("AGE-SECRET-KEY")), false);
  }
  passed("disk artifacts contain no private key and cannot reactivate a locked runtime");
  console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2));
} finally {
  assert.equal(invoke("lock").status, 0, "Cannot clean up the isolated runtime");
  rmSync(dir, { recursive: true, force: true });
  rmSync(runtime, { recursive: true, force: true });
  rmSync(`${runtime}.control.lock`, { force: true });
}
