import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { parseRootHashMapXmlStringPuts } from "../../src/translator/xml-utils.js";

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

it("serializes existing mapped button callbacks without executing them during form-only projection", () => {
  const root = mkdtempSync(join(tmpdir(), "caption-button-offline-"));
  try {
    const manifest = join(root, "manifest.json"), output = join(root, "result");
    writeFileSync(manifest, JSON.stringify({ items: [{ id: "bid", name: "Bid",
      sourcePath: "tests/fixtures/source/1927955f6e544383f46970f48468a743" }] }));
    execFileSync(process.execPath, ["scripts/verify-caption-folding.mjs", manifest, output], { stdio: "pipe" });
    const report = JSON.parse(readFileSync(join(output, "report.json")));
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.networkAttempts, 0);
    assert.equal(report.rows[0].nativeFormProjectionVerified, true);
    assert.equal(report.rows[0].nativeProjectionLimitation, undefined);
    assert.equal(report.summary.folded, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("returns incomplete when zero titles merge despite all configuration checks passing", () => {
  const root = mkdtempSync(join(tmpdir(), "caption-zero-merge-"));
  try {
    const props = parseRootHashMapXmlStringPuts(readFileSync("tests/fixtures/route-validation/caption-relationship-model/ordinary_SysFormTemplate.xml", "utf8"));
    props.fdDisplayJsp += "<script>unknownPresentationPlugin();</script>";
    const encode = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const file = join(root, "zero_SysFormTemplate.xml");
    writeFileSync(file, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") + "</object></java>");
    const manifest = join(root, "manifest.json"), ledger = join(root, "reviewed.json"), output = join(root, "result");
    writeFileSync(manifest, JSON.stringify({ items: [{ id: "ordinary", name: "Ordinary", sourcePath: file }] }));
    const pairs = [["fd_3c6687b7d57610", "fd_3c6687b047e8c6", "申请人"],
      ["fd_3c6687bb93f482", "fd_3c6687b195039e", "工号"], ["fd_3c6687b9a7ba5a", "fd_3c6687b2c4ecac", "申请部门"]];
    writeFileSync(ledger, JSON.stringify({ forms: [{ id: "ordinary", inputs: [{ path: file,
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }],
      relations: pairs.map(([fieldId, captionId, title]) => ({ fieldId, captionIds: [captionId], title,
        sourceRef: `source.form.control.${fieldId}`, expectation: "merge", basis: "reviewed original literal row" })) }] }));
    assert.throws(() => execFileSync(process.execPath, ["scripts/verify-caption-folding.mjs", manifest, output, ledger], { stdio: "pipe" }), error => error.status === 2);
    const { summary } = JSON.parse(readFileSync(join(output, "report.json")));
    assert.equal(summary.configurationSafe, 1);
    assert.deepEqual(summary.captionGoal, { assessed: true, required: 3, actual: 0, exceptions: 0, needsEvidence: 0, remaining: 3, status: "incomplete" });
  } finally { rmSync(root, { force: true, recursive: true }); }
});
