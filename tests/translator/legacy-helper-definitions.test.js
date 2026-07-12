import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftMkScriptsFromSourceScripts } from "../../src/translator/sysform-jsp-scripts.js";

describe("legacy helper-only scripts", () => {
  it("omits script blocks that only define helper functions", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [source(`
        function hideAll(){
          common_dom_row_set_show_required_reset("fd_row", false, false, false);
        }

        function showOne(){
          common_dom_row_set_show_required_reset("fd_row", true, true, false);
        }
      `)]
    });

    assert.equal(scripts.actions.length, 1);
    assert.equal(scripts.actions[0].translationStatus, "omitted");
    assert.equal(scripts.actions[0].function, "");
    assert.deepEqual(scripts.actions[0].coverage, { status: "covered", nativeRules: [], residuals: [] });
    assert.deepEqual(scripts.actions[0].functionMappings, [{
      source: "legacy helper function definitions",
      target: "inlined translated script actions",
      basis: "legacy-runtime-noop",
      reviewRequired: false
    }]);
  });

  it("keeps helper scripts with top-level execution reviewable", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [source(`
        function hideAll(){
          common_dom_row_set_show_required_reset("fd_row", false, false, false);
        }
        hideAll();
      `)]
    });

    assert.equal(scripts.actions[0].translationStatus, "needs_review");
  });
});

function source(javascript) {
  return {
    id: "helper.script.1",
    sourceRef: "source.form.jsp.helper.script.1",
    javascript,
    functionAudit: { matched: [], violations: [] }
  };
}
