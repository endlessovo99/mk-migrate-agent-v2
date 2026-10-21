import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";

it("verifies a real source offline and refuses to overwrite an earlier result", () => {
  const root = mkdtempSync(join(tmpdir(), "caption-offline-"));
  try {
    const fixture = "tests/fixtures/route-validation/native-caption-real-export/news_SysFormTemplate.xml";
    const before = readFileSync(fixture, "utf8");
    const manifest = join(root, "manifest.json"), output = join(root, "result");
    writeFileSync(manifest, JSON.stringify({ items: [{ id: "news", name: "News", sourcePath: fixture }] }));
    const args = ["scripts/verify-caption-folding.mjs", manifest, output];
    execFileSync(process.execPath, args, { stdio: "pipe" });
    const reportText = readFileSync(join(output, "report.json"), "utf8");
    const report = JSON.parse(reportText);
    assert.equal(report.summary.verified, 1);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.folded, 4);
    assert.equal(report.summary.networkAttempts, 0);
    assert.equal(report.rows[0].nativeFormProjectionVerified, true);
    assert.equal(JSON.parse(readFileSync(join(output, "01-draft.json"))).artifact, "dsl-draft");
    assert.throws(() => execFileSync(process.execPath, args, { stdio: "pipe" }));
    assert.equal(readFileSync(join(output, "report.json"), "utf8"), reportText);
    assert.equal(readFileSync(fixture, "utf8"), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
