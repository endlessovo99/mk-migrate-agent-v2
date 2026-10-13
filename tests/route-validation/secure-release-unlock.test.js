import assert from "node:assert/strict";
import { it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlockRelease } from "../../tools/secure-release/unlock-local.mjs";

function setup(reply, exitCode = 0) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mk-unlock-test-")));
  mkdirSync(join(dir, "private"));
  mkdirSync(join(dir, "bin"));
  const metadata = { releaseId: "fixture-release", sha256: "a".repeat(64) };
  writeFileSync(join(dir, "release.json"), JSON.stringify(metadata));
  writeFileSync(join(dir, "private/unlock.key"), "fixture-key-not-a-real-secret", { mode: 0o600 });
  writeFileSync(join(dir, "bin/ssh"), `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(JSON.stringify(reply(metadata)))}); process.exitCode = ${exitCode}; });\n`, { mode: 0o700 });
  return { dir, metadata };
}

for (const [name, reply, code] of [
  ["missing", () => ({}), 0],
  ["wrong release", (metadata) => ({ ...metadata, status: "unlocked", releaseId: "wrong" }), 0],
  ["wrong digest", (metadata) => ({ ...metadata, status: "unlocked", sha256: "b".repeat(64) }), 0],
  ["lost connection", (metadata) => ({ ...metadata, status: "unlocked" }), 255]
]) it(`retains the key after a ${name} unlock receipt`, () => {
  const { dir } = setup(reply, code);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${join(dir, "bin")}:${originalPath}`;
    assert.throws(() => unlockRelease({ release: dir, host: "fixture-host", "remote-package": "/opt/release.age" }), /receipt|mismatch/);
    assert.ok(existsSync(join(dir, "private/unlock.key")));
    assert.ok(!existsSync(join(dir, "unlock-receipt.json")));
  } finally { process.env.PATH = originalPath; rmSync(dir, { recursive: true, force: true }); }
});

it("removes only the local key after a matching successful receipt and blocks local reuse", () => {
  const { dir } = setup((metadata) => ({ ...metadata, status: "unlocked" }));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${join(dir, "bin")}:${originalPath}`;
    assert.equal(unlockRelease({ release: dir, host: "fixture-host", "remote-package": "/opt/release.age" }).localKeyRemoved, true);
    assert.ok(!existsSync(join(dir, "private/unlock.key")));
    assert.equal(JSON.parse(readFileSync(join(dir, "unlock-receipt.json"))).status, "unlocked");
    assert.throws(() => unlockRelease({ release: dir, host: "fixture-host", "remote-package": "/opt/release.age" }), /receipt/);
  } finally { process.env.PATH = originalPath; rmSync(dir, { recursive: true, force: true }); }
});
