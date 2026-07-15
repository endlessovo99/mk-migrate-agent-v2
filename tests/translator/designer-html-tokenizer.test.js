import assert from "node:assert/strict";
import test from "node:test";

import {
  findMatchingCloseTag,
  matchingElementFragment
} from "../../src/translator/designer-html-tokenizer.js";

test("matchingElementFragment includes a closing tag adjacent to an empty control", () => {
  const html = '<div fd_type="textarea"></div><span>next</span>';
  const match = /<([a-z]+)\b([^>]*)>/i.exec(html);

  assert.equal(matchingElementFragment(html, match), '<div fd_type="textarea"></div>');
});

test("findMatchingCloseTag distinguishes an unmatched element from a close at the content boundary", () => {
  assert.equal(findMatchingCloseTag("<div></div>", 5, "div"), 5);
  assert.equal(findMatchingCloseTag("<div>unclosed", 5, "div"), -1);
});
