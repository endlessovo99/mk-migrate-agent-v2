import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sourceCaptionBehavior } from "../../src/translator/dsl-draft.js";
import { prepareSample } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/choice-other-radio-scan/choice-other-radio-scan_SysFormTemplate.xml";

it("bounds a radio-only source scan outside a checkbox Other pair", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const choice = source.form.controls.find(field => field.id === "fd_kind");
  assert.equal(choice.sourceProps.otherPairContext?.radioFree, true);
  assert.equal(draft.form.fields.find(field => field.id === "fd_kind").otherPresentation?.optionValue, "OT");
  assert.deepEqual(draft.form.fields.find(field => field.id === "fd_kind").props.options, choice.options);
  assert.equal(draft.form.fields.find(field => field.id === "fd_note").props.defaultValue.value, "  seed_under_score🙂  ");
  const proof = sourceCaptionBehavior(source).forPair("fd_kind", "fd_note", choice.sourceProps.otherPairContext);
  assert.equal(proof.ok, true);
  assert.equal(proof.evidence?.proofMode, "pair-radio-scan-boundary");
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
  const original = structuredClone(source);
  delete original.form.controls.find(field => field.id === "fd_kind").sourceProps.otherPairContext.radioFree;
  assert.deepEqual(draft.scripts, draftSourceDraft(original).scripts, "the proof must never rewrite the source script projection");
});

it("keeps unrelated legacy scripts on the review gate and sends no native request", async () => {
  const result = await runRouteCase("qt-radio-scan-needs-script-review");
  assert.equal(result.review.stage, "agent-review.incomplete");
  assert.equal(result.dsl.form.fields.find(field => field.id === "fd_kind").otherPresentation.optionValue, "OT");
  assert.deepEqual(result.transcript, []);
});

it("fails closed for radio-scan mutations, alias escape, or radio controls in the Other cell", () => {
  const dir = mkdtempSync(join(tmpdir(), "other-radio-scan-"));
  try {
    const xml = readFileSync(fixture, "utf8"), mutants = [
      xml.replace('inpt[i].parentNode.innerHTML.indexOf("标准")!=-1', 'inpt[i].parentNode.innerHTML="changed"'),
      xml.replace('inpt=document.getElementsByTagName("input");', 'leak(cat);inpt=document.getElementsByTagName("input");'),
      xml.replace('getAttribute("checked")', 'getAttribute(dynamicName)'),
      xml.replace('var flag=1;', 'var flag=1;window.flag=1;'),
      xml.replace('var flag=1;', 'var flag=cat;'),
      xml.replace('inpt=document.getElementsByTagName("input");', 'var flag=GetXFormFieldById("fd_context");inpt=document.getElementsByTagName("input");'),
      xml.replace('getAttribute("type")=="radio"', 'getAttribute("type")=="checkbox"'),
      xml.replace('if(selected=="A"||flag==1)', 'GetXFormFieldById(String(flag)).show();if(selected=="A"||flag==1)'),
      xml.replace('&lt;script&gt;Com_AddEventListener', '&lt;script src="/unknown.js"&gt;&lt;/script&gt;&lt;script&gt;Com_AddEventListener'),
      xml.replace('&lt;/xform:checkbox&gt;&lt;xform:xtext', '&lt;/xform:checkbox&gt;&lt;input type="radio"/&gt;&lt;xform:xtext'),
      xml.replace('&lt;/xform:checkbox&gt;&lt;xform:xtext', '&lt;/xform:checkbox&gt;&lt;iframe src="/other"&gt;&lt;/iframe&gt;&lt;xform:xtext')
    ];
    for (const [i, contents] of mutants.entries()) {
      assert.notEqual(contents, xml, `mutant ${i} must be effective`);
      const file = join(dir, `mutant-${i}_SysFormTemplate.xml`); writeFileSync(file, contents);
      const dsl = draftSourceDraft(cleanSourceFile(file));
      assert.equal(dsl.form.fields.some(field => field.otherPresentation), false, `mutant ${i}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
