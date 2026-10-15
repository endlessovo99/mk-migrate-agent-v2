import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { maskJavaScriptComments } from "../../src/dsl/javascript-comments.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { decodeEntities } from "../../src/translator/xml-utils.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/script-field-reference-comments/route-comment-fields_SysFormTemplate.xml";
const kept = ["fd_code_real", "fd_url_real", "fd_string_block", "fd_string_line", "fd_regex_real", "fd_template_text", "fd_template_expr", "fd_choice", "fd_copy"];
const omitted = ["fd_line_comment", "fd_block_comment", "fd_template_comment", "fd_inline_comment"];

function originalScript() {
  const xml = readFileSync(fixture, "utf8");
  const encoded = xml.match(/<string>fdDisplayJsp<\/string><string>([\s\S]*?)<\/string>/)[1];
  return decodeEntities(encoded).match(/<script>([\s\S]*)<\/script>/)[1];
}

describe("JavaScript comment field-reference Route-validation", () => {
  it("removes only comment IDs from semantic facts and keeps the exact script", () => {
    const source = cleanSourceFile(fixture);
    const script = source.scripts.sources[0];
    assert.equal(script.javascript, originalScript());
    assert.deepEqual(script.semanticFacts.fieldIds, kept);
    for (const id of omitted) assert.ok(script.javascript.includes(id));
    assert.deepEqual(script.semanticFacts.eventBindings, []);
    const draft = draftSourceDraft(source);
    assert.equal(draft.scripts.actions[0].event, "onLoad");
    assert.equal(draft.scripts.actions[0].translationStatus, "needs_review");
  });

  it("removes the same comment IDs from scoped prompts without changing action source", () => {
    const source = cleanSourceFile(fixture);
    const before = JSON.stringify(source);
    const draft = draftSourceDraft(source);
    for (const compact of [false, true]) {
      const prompt = buildAgentReviewPrompt(source, draft, {
        compact, reviewScope: { actionIndexes: [0], actionIds: [draft.scripts.actions[0].id], includeFormTargets: false }
      });
      const action = prompt.context.dslDraft.scripts.actions[0].actionSource;
      assert.deepEqual(action.fieldIds, kept);
      assert.equal(action.excerpt, originalScript());
      assert.equal(JSON.stringify(source), before);
    }
  });

  it("preserves strings, regex literals, newlines, and UTF-16 offsets", () => {
    const script = originalScript();
    const masked = maskJavaScriptComments(script);
    assert.equal(masked.length, script.length);
    assert.deepEqual(masked.split("").flatMap((char, index) => char === "\n" ? [index] : []),
      script.split("").flatMap((char, index) => char === "\n" ? [index] : []));
    for (const id of kept) assert.equal(masked.indexOf(id), script.indexOf(id), id);
    for (const id of omitted) assert.equal(masked.includes(id), false, id);
    assert.ok(masked.includes('"/* fd_string_block */ // fd_string_line"'));
    assert.ok(masked.includes(String.raw`/fd_regex_real\/\//`));
    assert.ok(masked.includes("12 / 3"));
    assert.ok(script.includes("🧵") && script.includes("🦊"));
  });

  it("retains all original evidence when parsing is uncertain", () => {
    for (const script of [
      '// fd_possible_comment\nvar value = "fd_unclosed',
      '/* fd_unclosed_comment',
      'function incomplete(){ // fd_possible_comment',
      'var pattern = /fd_unclosed_regex',
      '// fd_possible_comment\nvar value = ;'
    ]) assert.equal(maskJavaScriptComments(script), script);
  });

  it("does not turn an unsupported value-change queue into executable migration", async () => {
    const result = await runRouteCase("script-field-reference-comments-blocked");
    assert.equal(result.review.ok, false);
    assert.equal(result.execution, undefined);
    assert.equal(result.dsl.trust?.executable === true, false);
    assert.deepEqual(result.transcript, []);
  });
});
