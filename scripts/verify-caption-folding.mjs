import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { auditCaptionFolding, cleanSourceFile, draftSourceDraft } from "../src/translator/index.js";
import { canonicalJson } from "../src/agent-review/digest.js";
import { prepareSample } from "../tests/helpers/persistence.js";

// Offline verification harness, not a migration entry point. Only new local
// artifacts are written; no batch store, credentials or NewOA client is loaded.
const [manifestPath, outputPath] = process.argv.slice(2);
assert.ok(manifestPath && outputPath, "Usage: node scripts/verify-caption-folding.mjs <manifest.json> <new-output-dir>");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert.ok(Array.isArray(manifest.items) && manifest.items.length);
fs.mkdirSync(outputPath, { mode: 0o700 });
const write = (name, value) => fs.writeFileSync(path.join(outputPath, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("Network access is forbidden in offline caption verification"); };
const rows = [];
for (const item of manifest.items) {
  const row = { id: item.id, name: item.name, status: "failed" };
  try {
    const inputFiles = fs.statSync(item.sourcePath).isDirectory()
      ? fs.readdirSync(item.sourcePath).filter(name => /\.xml$/i.test(name)).map(name => path.join(item.sourcePath, name))
      : [item.sourcePath];
    row.inputs = inputFiles.map(file => ({ path: file, sha256: hash(file) }));
    const source = cleanSourceFile(item.sourcePath), draft = draftSourceDraft(source);
    const audit = auditCaptionFolding(source, draft);
    assert.equal(audit.ok, true, JSON.stringify(audit.issues));
    const retainedSource = structuredClone(source);
    for (const field of [...(retainedSource.form.controls || []), ...(retainedSource.form.dataFields || [])]) {
      if (field.sourceProps) delete field.sourceProps.staticCaptionFact;
    }
    const baseline = draftSourceDraft(retainedSource);
    assert.deepEqual(draft.form.layout.sourceGrid, baseline.form.layout.sourceGrid, "Caption folding changed source-grid projection");
    assert.equal(canonicalJson(draft.scripts), canonicalJson(baseline.scripts), "Caption folding changed scripts");
    assert.equal(canonicalJson(draft.formRules), canonicalJson(baseline.formRules), "Caption folding changed rules");
    assert.equal(canonicalJson(draft.workflow), canonicalJson(baseline.workflow), "Caption folding changed workflow");
    const folded = draft.form.fields.filter(field => field.sourceProps?.foldedCaption);
    const consumed = new Set(folded.map(field => field.sourceProps.foldedCaption.id));
    assert.equal(baseline.form.fields.length - draft.form.fields.length, consumed.size);
    for (const field of draft.form.fields) {
      const prior = baseline.form.fields.find(other => other.sourceRef === field.sourceRef);
      assert.ok(prior, `Unexpected field ${field.id}`);
      const normalized = structuredClone(field);
      delete normalized.sourceProps.staticCaptionFact;
      if (field.sourceProps?.foldedCaption) {
        normalized.title = prior.title;
        normalized.props = structuredClone(prior.props);
        // Props other than the hidden-title flag must remain unchanged.
        const { hiddenLabel: ignored, ...priorProps } = prior.props;
        assert.deepEqual(field.props, priorProps);
        delete normalized.sourceProps.foldedCaption;
      }
      assert.deepEqual(normalized, prior, `Unrelated field semantics changed: ${field.id}`);
    }
    // Project the complete form, with synthetic identity. Script/workflow
    // execution and authorization resolution are outside this title check.
    const projection = structuredClone(draft);
    delete projection.template.authorization;
    delete projection.workflow;
    projection.scripts = { actions: [] };
    projection.formRules = { linkage: [] };
    try {
      const prepared = prepareSample(projection);
      const readback = prepared.verify(prepared.update);
      assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
      const native = JSON.parse(prepared.update.mechanisms["sys-xform"].fdConfig);
      const nativeFields = native.dataModel.flatMap(model => model.fdFields || []);
      for (const field of folded) {
        assert.equal(nativeFields.filter(other => other.fdName === field.id).length, 1);
        assert.equal(nativeFields.some(other => other.fdName === field.sourceProps.foldedCaption.id), false);
        const config = JSON.parse(nativeFields.find(other => other.fdName === field.id).fdAttribute).config;
        assert.equal(config.labelProps.title, field.title);
        for (const scene of ["desktop", "mobile"]) {
          assert.notEqual(config.labelProps[scene]?.hiddenLabel, true);
          assert.notEqual(config.controlProps[scene]?.hiddenLabel, true);
        }
      }
      row.nativeFormProjectionVerified = true;
    } catch (error) {
      if (folded.length) throw error;
      row.nativeFormProjectionVerified = false;
      row.nativeProjectionLimitation = error.message;
    }
    row.decisions = audit.decisions;
    for (const status of ["folded", "preserved", "unproven"]) row[status] = audit.decisions.filter(item => item.status === status).length;
    row.reasons = Object.fromEntries([...new Set(audit.decisions.map(item => item.reason))]
      .map(reason => [reason, audit.decisions.filter(item => item.reason === reason).length]));
    row.previousFolded = item.previousDslPath
      ? JSON.parse(fs.readFileSync(item.previousDslPath, "utf8")).dsl.form.fields.filter(field => field.sourceProps?.foldedCaption).length : null;
    row.status = "verified";
    for (const input of row.inputs) assert.equal(hash(input.path), input.sha256);
    const ordinal = String(rows.length + 1).padStart(2, "0");
    write(`${ordinal}-source.json`, source);
    write(`${ordinal}-draft.json`, draft);
  } catch (error) {
    row.error = { message: error.message, diagnostics: error.diagnostics };
  }
  rows.push(row);
  write("report.json", { scope: "offline caption/form structure only", networkAttempts, rows });
  console.log(JSON.stringify({ name: row.name, status: row.status, folded: row.folded, preserved: row.preserved, unproven: row.unproven, error: row.error?.message?.slice(0,180) }));
}
assert.equal(networkAttempts, 0);
const total = status => rows.reduce((sum, row) => sum + (row[status] || 0), 0);
const summary = { forms: rows.length, verified: rows.filter(row => row.status === "verified").length,
  failed: rows.filter(row => row.status !== "verified").length, folded: total("folded"),
  preserved: total("preserved"), unproven: total("unproven"),
  nativeFormProjectionsVerified: rows.filter(row => row.nativeFormProjectionVerified).length,
  nativeProjectionLimitations: rows.filter(row => row.nativeProjectionLimitation).length, networkAttempts };
write("report.json", { scope: "offline caption/form structure only; no model, workflow execution or live persistence acceptance", summary, rows });
const markdown = `# Offline caption verification\n\n${JSON.stringify(summary)}\n\n` +
  "Verified means classification and preservation checks passed. Every folded form must also pass native form projection. Projection limitations on unchanged forms are listed separately. Unproven titles remain separate and are not counted as merge success.\n\n" +
  "| Flow | Result | Folded | Protected | Unproven |\n|---|---|---:|---:|---:|\n" +
  rows.map(row => `| ${row.name.replaceAll("|", "\\|")} | ${row.status} | ${row.folded ?? "-"} | ${row.preserved ?? "-"} | ${row.unproven ?? "-"} |`).join("\n");
fs.writeFileSync(path.join(outputPath, "REPORT.md"), markdown + "\n", { mode: 0o600 });
console.log(JSON.stringify(summary));
if (summary.failed) process.exitCode = 1;
