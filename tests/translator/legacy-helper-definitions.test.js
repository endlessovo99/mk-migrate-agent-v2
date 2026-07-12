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

  it("omits helper libraries with comments and inert top-level constants", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [source(`
        // Shared finance helper declarations.
        var columns = ['fd_amount', 'fd_currency'];
        const tableId = 'fd_finance_detail';

        function buildRows(){
          return columns.map(function (column) { return column + tableId; });
        }

        /* No top-level invocation: callbacks call this helper elsewhere. */
        function normalizeAmount(value){
          return Number(value || 0).toFixed(2);
        }
      `)]
    });

    assert.equal(scripts.actions.length, 1);
    assert.equal(scripts.actions[0].translationStatus, "omitted");
    assert.equal(scripts.actions[0].function, "");
  });

  it("keeps variable initializers with top-level calls reviewable", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [source(`
        function buildRows(){ return []; }
        var rows = buildRows();
      `)]
    });

    assert.equal(scripts.actions[0].translationStatus, "needs_review");
  });

  it("keeps unknown or side-effecting initializer expressions reviewable", () => {
    const initializers = [
      "const value = `${loadData()}`;",
      "const value = new SideEffect();",
      "const value = tag`payload`;",
      "const value = target.value = 1;",
      "const value = counter++;"
    ];

    for (const initializer of initializers) {
      const scripts = draftMkScriptsFromSourceScripts({
        source: "sysform-jsp",
        sources: [source(`function helper() { return true; }\n${initializer}`)]
      });
      assert.equal(scripts.actions[0].translationStatus, "needs_review", initializer);
    }
  });

  it("omits declarations initialized only with nested literal values", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [source(`
        const config = { labels: ["a", "b"], enabled: true, limits: { min: -1, max: 2 } };
        let empty;
        function helper() { return config; }
      `)]
    });

    assert.equal(scripts.actions[0].translationStatus, "omitted");
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
