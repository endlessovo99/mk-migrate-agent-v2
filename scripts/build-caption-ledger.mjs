import fs from "node:fs";
import path from "node:path";
import { cleanSourceFile } from "../src/translator/index.js";
import { sourceCaptionBehavior } from "../src/translator/dsl-draft.js";
import { hashFile, reviewCaptionLedger } from "./lib/caption-relation-review.js";

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw new Error("Usage: node scripts/build-caption-ledger.mjs <manifest.json> <ledger.json>");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const forms = [];
for (const item of manifest.items) {
  const inputFiles = fs.statSync(item.sourcePath).isDirectory()
    ? fs.readdirSync(item.sourcePath).filter(name => /\.xml$/i.test(name)).map(name => path.join(item.sourcePath, name))
    : [item.sourcePath];
  const source = cleanSourceFile(item.sourcePath);
  const behavior = sourceCaptionBehavior(source);
  const pairImpact = behavior ? (fieldId, captionId, context) => behavior.forPair(fieldId, captionId, context) : undefined;
  const ledger = reviewCaptionLedger(source, inputFiles.map(file => ({ path: file, sha256: hashFile(file) })), pairImpact);
  forms.push({ id: item.id, name: item.name, ...ledger });
  const counts = {};
  for (const relation of ledger.relations) counts[relation.expectation] = (counts[relation.expectation] || 0) + 1;
  console.log(JSON.stringify({ name: item.name, ...counts, relations: ledger.relations.length }));
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(outputPath, JSON.stringify({
  basis: "Independent structure from source binding, adjacent cells, rendered control and permission wrapper. Script allowance uses the behavior contract's closed impact, not foldedCaption or fold status.",
  forms
}, null, 2), { mode: 0o600 });
