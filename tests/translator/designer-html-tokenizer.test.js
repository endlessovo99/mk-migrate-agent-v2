import assert from "node:assert/strict";
import test from "node:test";

import {
  findMatchingCloseTag,
  matchingElementFragment,
  splitDirectChildCells
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

test("splitDirectChildCells retains unquoted legacy title-cell classes", () => {
  const cells = splitDirectChildCells(
    '<TR><TD CLASS=td_normal_title WIDTH=120 rowSpan=2>Caption</TD><TD class="td_normal" width=80%>Value</TD></TR>',
    { includeUnquotedWidth: true }
  );

  assert.equal(cells[0].attrs.class, "td_normal_title");
  assert.equal(cells[0].attrs.rowspan, "2");
  assert.equal(cells[0].attrs.width, "120");
  assert.equal(cells[1].attrs.class, "td_normal");
  assert.equal(cells[1].attrs.width, "80%");
});
