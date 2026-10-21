import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import net from "node:net";
import { auditCaptionFolding, cleanSourceFile, draftSourceDraft } from "../src/translator/index.js";
import { canonicalJson } from "../src/agent-review/digest.js";
import { prepareSample } from "../tests/helpers/persistence.js";
import { auditCaptionAcceptance } from "./lib/caption-acceptance.js";

// Offline verification harness, not a migration entry point. Only new local
// artifacts are written; no batch store, credentials or NewOA client is loaded.
const [manifestPath, outputPath, expectationsPath] = process.argv.slice(2);
assert.ok(manifestPath && outputPath, "Usage: node scripts/verify-caption-folding.mjs <manifest.json> <new-output-dir>");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const expectations = expectationsPath ? JSON.parse(fs.readFileSync(expectationsPath, "utf8")) : undefined;
assert.ok(Array.isArray(manifest.items) && manifest.items.length);
assert.equal(new Set(manifest.items.map(item => item.id)).size, manifest.items.length, "Duplicate manifest form identity");
if (expectations) {
  assert.ok(Array.isArray(expectations.forms), "Expected a reviewed forms inventory");
  assert.deepEqual(expectations.forms.map(form => form.id).sort(), manifest.items.map(item => item.id).sort(), "Reviewed form inventory differs from the manifest");
}
fs.mkdirSync(outputPath, { mode: 0o700 });
const write = (name, value) => fs.writeFileSync(path.join(outputPath, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
let networkAttempts = 0;
const forbidNetwork = () => { networkAttempts++; throw new Error("Network access is forbidden in offline caption verification"); };
globalThis.fetch = async () => forbidNetwork();
net.Socket.prototype.connect = forbidNetwork;
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
    delete retainedSource.form.captionRelations;
    for (const field of [...(retainedSource.form.controls || []), ...(retainedSource.form.dataFields || [])]) {
      if (field.sourceProps) {
        delete field.sourceProps.staticCaptionFact;
        delete field.sourceProps.captionStructure;
      }
    }
    const baseline = draftSourceDraft(retainedSource);
    assert.deepEqual(draft.form.layout.sourceGrid, baseline.form.layout.sourceGrid, "Caption folding changed source-grid projection");
    assert.equal(canonicalJson(draft.scripts), canonicalJson(baseline.scripts), "Caption folding changed scripts");
    assert.equal(canonicalJson(draft.formRules), canonicalJson(baseline.formRules), "Caption folding changed rules");
    const folded = draft.form.fields.filter(field => field.sourceProps?.foldedCaption);
    const consumed = new Set(folded.map(field => field.sourceProps.foldedCaption.id));
    const expectedWorkflow = structuredClone(baseline.workflow);
    for (const field of folded) for (const node of expectedWorkflow?.nodes || []) {
      const rights = node.dataAuthority?.fields, captionId = field.sourceProps.foldedCaption.id;
      if (!rights?.[captionId]) continue;
      assert.equal(rights[captionId].visible, rights[field.id]?.visible, "Independent title visibility cannot be consumed");
      assert.equal(rights[captionId].sourceMode, rights[field.id]?.sourceMode, "Independent title permissions cannot be consumed");
      delete rights[captionId];
    }
    assert.deepEqual(draft.workflow, expectedWorkflow, "Caption folding changed workflow business semantics");
    const expectedTree = structuredClone(baseline.form.layout.mkTree);
    for (const field of folded) {
      const captionId = field.sourceProps.foldedCaption.referenceMap?.formerControlId || field.sourceProps.foldedCaption.id;
      const row = expectedTree.find(row => row.children?.some(cell => cell.refIds?.includes(captionId)));
      const left = row?.children.find(cell => cell.refIds?.includes(captionId));
      const right = row?.children.find(cell => cell.refIds?.includes(field.id));
      assert.ok(left && right && left.column + left.colspan === right.column, "Caption fold must join its complete adjacent source region");
      right.column = left.column; right.colspan += left.colspan;
      if (Number.isFinite(left.widthWeight) && Number.isFinite(right.widthWeight)) right.widthWeight += left.widthWeight;
      else delete right.widthWeight;
      row.children = row.children.filter(cell => cell !== left);
    }
    assert.deepEqual(draft.form.layout.mkTree, expectedTree, "Unexpected target layout change outside joined caption regions");
    assert.equal(baseline.form.fields.length - draft.form.fields.length, consumed.size);
    for (const field of draft.form.fields) {
      const prior = baseline.form.fields.find(other => other.sourceRef === field.sourceRef);
      assert.ok(prior, `Unexpected field ${field.id}`);
      const normalized = structuredClone(field);
      delete normalized.sourceProps.staticCaptionFact;
      delete normalized.sourceProps.captionStructure;
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
    const buttonIds = new Set(projection.form.fields.filter(field => field.componentId === "xform-button").map(field => field.id));
    projection.scripts = { actions: (draft.scripts?.actions || [])
      .filter(action => action.event === "onClick" && buttonIds.has(action.controlId)) };
    projection.formRules = { linkage: [] };
    try {
      const prepared = prepareSample(projection);
      const readback = prepared.verify(prepared.update);
      assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
      const native = JSON.parse(prepared.update.mechanisms["sys-xform"].fdConfig);
      row.captionGoal = auditCaptionAcceptance(expectations?.forms?.find(form => form.id === item.id), draft, native, row.inputs);
      if (expectations && !row.captionGoal.assessed) throw new Error(`Missing independent caption acceptance ledger for ${item.id}`);
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
    row.configurationSafe = true;
    row.captionGoal ||= auditCaptionAcceptance(undefined);
    for (const input of row.inputs) assert.equal(hash(input.path), input.sha256);
    const ordinal = String(rows.length + 1).padStart(2, "0");
    write(`${ordinal}-source.json`, source);
    write(`${ordinal}-draft.json`, draft);
  } catch (error) {
    row.error = { message: error.message, diagnostics: error.diagnostics };
  }
  rows.push(row);
  write("report.json", { scope: "offline caption/form structure only", networkAttempts, rows });
  console.log(JSON.stringify({ name: row.name, configurationSafe: row.configurationSafe || false,
    captionGoal: row.captionGoal?.status || "failed", required: row.captionGoal?.required, actual: row.captionGoal?.actual,
    remaining: row.captionGoal?.remaining, folded: row.folded, preserved: row.preserved, unproven: row.unproven, error: row.error?.message?.slice(0,180) }));
}
assert.equal(networkAttempts, 0);
const total = status => rows.reduce((sum, row) => sum + (row[status] || 0), 0);
const summary = { forms: rows.length, verified: rows.filter(row => row.status === "verified").length,
  failed: rows.filter(row => row.status !== "verified").length, folded: total("folded"),
  preserved: total("preserved"), unproven: total("unproven"),
  nativeFormProjectionsVerified: rows.filter(row => row.nativeFormProjectionVerified).length,
  nativeProjectionLimitations: rows.filter(row => row.nativeProjectionLimitation).length, networkAttempts };
summary.configurationSafe = rows.filter(row => row.configurationSafe).length;
summary.captionGoal = { assessed: Boolean(expectations),
  required: rows.reduce((n, row) => n + (row.captionGoal?.required || 0), 0),
  actual: rows.reduce((n, row) => n + (row.captionGoal?.actual || 0), 0),
  exceptions: rows.reduce((n, row) => n + (row.captionGoal?.exceptions || 0), 0),
  needsEvidence: rows.reduce((n, row) => n + (row.captionGoal?.needsEvidence || 0), 0),
  remaining: rows.reduce((n, row) => n + (row.captionGoal?.remaining || 0), 0),
  status: !expectations ? "not-assessed" : rows.some(row => !row.configurationSafe || row.captionGoal?.status === "failed")
    ? "failed" : rows.every(row => row.captionGoal?.status === "complete") ? "complete" : "incomplete" };
write("report.json", { scope: "offline caption/form structure only; no model, workflow execution or live persistence acceptance", summary, rows });
const markdown = `# Offline caption verification\n\n${JSON.stringify(summary)}\n\n` +
  "Configuration safety and caption-goal completion are separate. Without a reviewed expectation ledger, the goal is not assessed. A missing required merge or unresolved source relation is incomplete even when every configuration check passes. Native wrapper replay is offline; browser CSS and live persistence are not assessed.\n\n" +
  "| Flow | Config safe | Required | Merged | Exceptions | Needs evidence | Remaining | Goal |\n|---|---|---:|---:|---:|---:|---:|---|\n" +
  rows.map(row => `| ${row.name.replaceAll("|", "\\|")} | ${row.configurationSafe || false} | ${row.captionGoal?.required ?? "-"} | ${row.captionGoal?.actual ?? "-"} | ${row.captionGoal?.exceptions ?? "-"} | ${row.captionGoal?.needsEvidence ?? "-"} | ${row.captionGoal?.remaining ?? "-"} | ${row.captionGoal?.status || "failed"} |`).join("\n");
fs.writeFileSync(path.join(outputPath, "REPORT.md"), markdown + "\n", { mode: 0o600 });
console.log(JSON.stringify(summary));
if (summary.failed || summary.captionGoal.status === "failed") process.exitCode = 1;
else if (summary.captionGoal.status === "incomplete") process.exitCode = 2;
