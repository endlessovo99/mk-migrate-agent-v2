import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { cleanSourceFile } from "../../src/translator/index.js";
import { reviewCaptionRelations } from "../../scripts/lib/caption-relation-review.js";

const fixture = "tests/fixtures/route-validation/caption-relationship-model/ordinary_SysFormTemplate.xml";
const titles = ["申请人", "工号", "申请部门"];

it("expects the ordinary one-to-one titles to merge from source binding and layout", () => {
  const relations = reviewCaptionRelations(cleanSourceFile(fixture));
  assert.deepEqual(relations.map(item => [item.title, item.expectation]), titles.map(title => [title, "merge"]));
  assert.equal(relations.every(item => item.basis.includes("一对一绑定")), true);
  const source = readFileSync(new URL("../../scripts/lib/caption-relation-review.js", import.meta.url), "utf8");
  const imports = source.split("\n").filter(line => line.startsWith("import "));
  assert.equal(imports.some(line => /native-caption-fold|source-caption-relations|caption-behavior-contract|foldedCaption/.test(line)), false);
});
