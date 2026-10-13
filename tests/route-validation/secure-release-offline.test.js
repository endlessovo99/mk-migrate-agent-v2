import assert from "node:assert/strict";
import { it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { authorizeOffline, completeOffline } from "../../tools/secure-release/offline-local.mjs";
import { command, sha256 } from "../../tools/secure-release/common.mjs";
import { receiptProof } from "../../tools/secure-release/offline-common.mjs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/route-validation/secure-release/offline-handoff.json", import.meta.url)));
const cryptoOptions = { skip: spawnSync("age", ["--version"]).status !== 0 && "age required" };
function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mk-offline-route-")));
  for (const path of ["private", "upload"]) mkdirSync(join(dir, path));
  const identity = command("age-keygen", []);
  writeFileSync(join(dir, "private/unlock.key"), identity, { mode: 0o600 });
  identity.fill(0);
  const receiver = command("age-keygen", []);
  const recipient = command("age-keygen", ["-y"], { input: receiver, encoding: "utf8" }).trim();
  const request = { ...fixture, recipient, expiresAt: Date.now() + 30 * 60 * 1000 };
  const requestPath = join(dir, "request.json");
  writeFileSync(requestPath, JSON.stringify(request));
  writeFileSync(join(dir, "release.json"), JSON.stringify({ releaseId: fixture.releaseId, sha256: fixture.sha256 }));
  return {
    dir, request, receiver,
    options: { release: dir, request: requestPath, "request-sha256": sha256(readFileSync(requestPath)) },
    cleanup() { receiver.fill(0); rmSync(dir, { recursive: true, force: true }); }
  };
}
function makeReceipt(context, change = {}) {
  const state = JSON.parse(readFileSync(join(context.dir, "private", `offline-${fixture.requestId}.json`)));
  const receipt = { status: "unlocked", releaseId: fixture.releaseId, sha256: fixture.sha256, runtime: fixture.runtime, requestId: fixture.requestId };
  receipt.proof = receiptProof(receipt, state.receiptSecret);
  Object.assign(receipt, change);
  const path = join(context.dir, "receipt.json");
  writeFileSync(path, JSON.stringify(receipt));
  return path;
}

it("wraps the project identity for the temporary recipient and retains it until authenticated completion", cryptoOptions, () => {
  const context = setup();
  try {
    const ticket = authorizeOffline(context.options);
    assert.ok(existsSync(join(context.dir, "private/unlock.key")));
    assert.equal(readFileSync(ticket.ticketFile).includes(Buffer.from("AGE-SECRET-KEY")), false);
    const payload = JSON.parse(command("age", ["-d", "-i", "-", ticket.ticketFile], { input: context.receiver, encoding: "utf8" }));
    assert.equal(payload.requestId, fixture.requestId);
    assert.equal(sha256(Buffer.from(payload.identity)), sha256(readFileSync(join(context.dir, "private/unlock.key"))));
    assert.throws(() => authorizeOffline(context.options), /already exists/);
    const receipt = makeReceipt(context);
    assert.equal(completeOffline({ release: context.dir, receipt }).localKeyRemoved, true);
    assert.ok(!existsSync(join(context.dir, "private/unlock.key")));
    assert.ok(!existsSync(join(context.dir, "private", `offline-${fixture.requestId}.json`)));
    assert.throws(() => completeOffline({ release: context.dir, receipt }), /completed/);
  } finally { context.cleanup(); }
});

it("rejects a changed request fingerprint before releasing any key material", cryptoOptions, () => {
  const context = setup();
  try {
    assert.throws(() => authorizeOffline({ ...context.options, "request-sha256": "0".repeat(64) }), /fingerprint/);
    assert.ok(existsSync(join(context.dir, "private/unlock.key")));
  } finally { context.cleanup(); }
});

for (const [name, changes, pattern] of [
  ["expired", { expiresAt: 1 }, /expired/],
  ["different release", { sha256: "b".repeat(64) }, /different release/]
]) it(`rejects an ${name} request`, cryptoOptions, () => {
  const context = setup();
  try {
    writeFileSync(context.options.request, JSON.stringify({ ...context.request, ...changes }));
    context.options["request-sha256"] = sha256(readFileSync(context.options.request));
    assert.throws(() => authorizeOffline(context.options), pattern);
  } finally { context.cleanup(); }
});

it("retains the private key after a forged completion receipt", cryptoOptions, () => {
  const context = setup();
  try {
    authorizeOffline(context.options);
    const receipt = makeReceipt(context, { proof: "0".repeat(64) });
    assert.throws(() => completeOffline({ release: context.dir, receipt }), /proof mismatch/);
    assert.ok(existsSync(join(context.dir, "private/unlock.key")));
    assert.ok(!existsSync(join(context.dir, "unlock-receipt.json")));
  } finally { context.cleanup(); }
});

it("does not delete a private key replaced after authorization", cryptoOptions, () => {
  const context = setup();
  try {
    authorizeOffline(context.options);
    const receipt = makeReceipt(context);
    writeFileSync(join(context.dir, "private/unlock.key"), "replacement-key");
    assert.throws(() => completeOffline({ release: context.dir, receipt }), /changed/);
    assert.ok(existsSync(join(context.dir, "private/unlock.key")));
  } finally { context.cleanup(); }
});
