import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { buildBundle, decodeBundle, extractBundle, validateBundle } from "../../tools/secure-release/bundle.mjs";
import { command, sha256 } from "../../tools/secure-release/common.mjs";
import { packageRelease } from "../../tools/secure-release/package.mjs";
import { serverOptions } from "../../tools/secure-release/server-worker.mjs";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { findRouteCase } from "./manifest.js";
import { resolveRouteFixture } from "./fixture.js";
import { withNetworkGuard } from "./network-guard.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONTRACT = JSON.parse(readFileSync(new URL("../fixtures/route-validation/secure-release/contract.json", import.meta.url)));
const ageAvailable = spawnSync("age", ["--version"]).status === 0;
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "mk-secure-route-")));

describe("encrypted release route", () => {
  it("includes all runtime catalogs and schema while excluding plaintext data and credentials", () => {
    const { bundle, bytes } = buildBundle(ROOT);
    assert.equal(decodeBundle(bytes).releaseId, bundle.releaseId);
    assert.ok(bundle.files.some((file) => file.path === "src/batch/schema.sql"));
    assert.ok(bundle.files.some((file) => file.path === "catalogs/mk-components.v1.json"));
    for (const file of bundle.files) assert.ok(!CONTRACT.excludedPaths.some((prefix) => file.path.startsWith(prefix)));
    for (const root of CONTRACT.encryptedRoots) assert.ok(bundle.files.some((file) => file.path.startsWith(root)));
  });

  it("rejects traversal, duplicate paths, changed content, missing entrypoints and oversized decompression", () => {
    const { bundle } = buildBundle(ROOT);
    for (const path of CONTRACT.unsafePaths) {
      const altered = structuredClone(bundle);
      altered.files[0].path = path;
      assert.throws(() => validateBundle(altered), /path|collision/);
    }
    const duplicate = structuredClone(bundle);
    duplicate.files.push(duplicate.files[0]);
    assert.throws(() => validateBundle(duplicate), /duplicate/);
    const corrupt = structuredClone(bundle);
    corrupt.files[0].content = Buffer.from("changed").toString("base64");
    assert.throws(() => validateBundle(corrupt), /integrity/);
    const missing = structuredClone(bundle);
    missing.files = missing.files.filter((file) => file.path !== "src/cli/main.js");
    assert.throws(() => validateBundle(missing), /Missing/);
    assert.throws(() => decodeBundle(gzipSync(Buffer.alloc(65 * 1024 * 1024))));
  });

  it("rejects source symlinks and refuses to extract over existing files", () => {
    const dir = temp();
    try {
      mkdirSync(join(dir, "src"));
      symlinkSync(join(ROOT, "src/cli/main.js"), join(dir, "src/main.js"));
      assert.throws(() => buildBundle(dir), /symlink/);
      const { bundle } = buildBundle(ROOT);
      assert.throws(() => extractBundle(bundle, dir), /empty/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects overlapping code/data paths and requires an expected package digest", () => {
    assert.throws(() => serverOptions(["run", "--data", "/run/mk-migrate/engine/data", "--", "clean"]), /separate/);
    assert.throws(() => serverOptions(["unlock", "--package", "/opt/release.age"]), /SHA-256/);
    assert.throws(() => serverOptions(["unlock", "--package", "/opt/release.age", "--sha256", "a".repeat(64), "--registry", "http://registry.test"]), /HTTPS/);
    assert.deepEqual(serverOptions(["run", "--", "check", "execute", "dsl/migration.dsl.json"]).rest, ["check", "execute", "dsl/migration.dsl.json"]);
  });

  it("rejects releases under the repository and refuses to overwrite an output directory", { skip: !ageAvailable && "age is required for native crypto verification" }, () => {
    assert.throws(() => packageRelease({ root: ROOT, out: join(ROOT, ".tmp/release") }), /outside/);
    const dir = temp();
    try {
      assert.throws(() => packageRelease({ root: ROOT, out: dir }), /EEXIST/);
      symlinkSync(ROOT, join(dir, "repository-alias"));
      assert.throws(() => packageRelease({ root: ROOT, out: join(dir, "repository-alias/release") }), /symbolic links/);
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("decrypts a real age release, translates plaintext XML, persists trusted DSL and executes with fake NewOA", { skip: !ageAvailable && "age is required for native crypto verification" }, async () => {
    const dir = temp();
    try {
      const release = packageRelease({ root: ROOT, out: join(dir, "release") });
      const encryptedPath = join(release.uploadDirectory, "engine.mkpkg.age");
      const keyPath = join(dir, "release/private/unlock.key");
      assert.equal(statSync(keyPath).mode & 0o777, 0o600);
      assert.equal(sha256(readFileSync(encryptedPath)), release.sha256);
      assert.ok(!existsSync(join(release.uploadDirectory, "private")));
      const bundle = decodeBundle(command("age", ["-d", "-i", keyPath, encryptedPath]));
      const engine = join(dir, "engine");
      const data = join(dir, "data");
      mkdirSync(engine);
      mkdirSync(data);
      extractBundle(bundle, engine);
      symlinkSync(join(ROOT, "node_modules"), join(engine, "node_modules"));
      const imported = (path) => import(pathToFileURL(join(engine, "src", path)).href);
      await withNetworkGuard(async () => {
        const route = findRouteCase(CONTRACT.sourceCase);
        const input = join(data, "input_SysFormTemplate.xml");
        cpSync(resolveRouteFixture(route.source), input);
        const original = readFileSync(input);
        const { cleanSourceFile, draftSourceDraft } = await imported("translator/index.js");
        const { runAgentReview } = await imported("agent-review/index.js");
        const { buildDryRunPlan } = await imported("executor/dry-run.js");
        const { executeDsl } = await imported("executor/execute.js");
        const sourceDraft = cleanSourceFile(input, { templateName: route.source.templateName });
        const reviewed = await runAgentReview(sourceDraft, draftSourceDraft(sourceDraft), { provider: createFakeReviewProvider("accept"), reviewedAt: "2026-10-10T00:00:00.000Z" });
        assert.equal(reviewed.ok, true);
        const dslPath = join(data, "migration.dsl.json");
        writeFileSync(dslPath, JSON.stringify(reviewed.dsl));
        const dsl = JSON.parse(readFileSync(dslPath));
        assert.equal(buildDryRunPlan(dsl).ok, true);
        const client = new FakeNewoaAdapter("persist", { templateAuthorization: dsl.template.authorization });
        const report = await executeDsl(dsl, {
          client, confirmWrite: true, targetCategoryId: "route-category-id", baseUrl: "https://p-sit.onewo.com",
          credentials: { username: "fixture-user", encryptedPassword: "fixture-password" },
          now: new Date("2026-10-10T00:00:00.000Z"), transferRecordIdFactory: () => "secure-release-test-record"
        });
        assert.equal(report.ok, true);
        writeFileSync(join(data, "execution.report.json"), JSON.stringify(report));
        assert.deepEqual(readFileSync(input), original);
        rmSync(engine, { recursive: true });
        assert.equal(JSON.parse(readFileSync(dslPath)).trust.executable, true);
        assert.equal(JSON.parse(readFileSync(join(data, "execution.report.json"))).ok, true);
      });
      const bad = readFileSync(encryptedPath);
      bad[bad.length - 1] ^= 1;
      writeFileSync(join(dir, "tampered.age"), bad);
      assert.throws(() => command("age", ["-d", "-i", keyPath, join(dir, "tampered.age")]), /failed/);
      const otherKey = command("age-keygen", []);
      try { assert.throws(() => command("age", ["-d", "-i", "-", encryptedPath], { input: otherKey }), /failed/); }
      finally { otherKey.fill(0); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
