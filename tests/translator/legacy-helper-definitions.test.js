import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  draftMkScriptsFromSourceScripts,
  extractSysFormJspScripts
} from "../../src/translator/sysform-jsp-scripts.js";

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

  it("does not flag helper functions defined in another script block of the same JSP fragment", () => {
    const scripts = extractSysFormJspScripts({
      fdDesignerHtml: `
        <DIV id="fd_jsp" fd_type="jsp">
          <LABEL>
            <INPUT type="hidden" value='
              <script>
                function hideAll(){
                  common_dom_row_set_show_required_reset("fd_row", false, false, false);
                }
              </script>
              <xform:editShow>
                <script>
                  Com_AddEventListener(window, "load", function(){
                    hideAll();
                    common_dom_row_set_show_required_reset("fd_row", true, true, false);
                  });
                </script>
              </xform:editShow>
            '>
          </LABEL>
        </DIV>
      `
    });

    const editScript = scripts.sources.find((item) => item.displayGate === "xform:editShow");
    assert.ok(editScript);
    assert.equal(
      editScript.functionAudit.violations.some((item) => item.name === "hideAll"),
      false
    );

    const drafted = draftMkScriptsFromSourceScripts(scripts);
    const reviewAction = drafted.actions.find((item) => item.translationStatus === "needs_review");
    assert.match(reviewAction.function, /function hideAll\s*\(\s*\)/);
    assert.match(reviewAction.function, /hideAll\(\);/);
  });

  it("maps quality fast report row visibility helper without dynamic setFieldAttr targets", () => {
    const scripts = extractSysFormJspScripts({
      fdDesignerHtml: `
        <DIV id="fd_quality_jsp" fd_type="jsp">
          <LABEL>
            <INPUT type="hidden" value='
              <script>
                function hideAll(){
                  common_dom_row_set_show_required_reset("fd_zdpp_row", false, false, false);
                  common_dom_row_set_show_required_reset("fd_jjzlsj_row", false, false, false);
                }
                function judgeMethod(input1,input2,input3){
                  document.getElementById("fd_qylb_con").value = input1;
                  document.getElementById("fd_sjlb_con").value = input2;
                  document.getElementById("fd_yxlb_con").value = input3;
                  if(input2=="zdzlsj" && input3=="ppyx"){
                    common_dom_row_set_show_required_reset("fd_zdpp_row", true, true, false);
                  }
                }
              </script>
              <xform:editShow>
                <script>
                  Com_AddEventListener(window, "load", function(){
                    hideAll();
                    judgeMethod(
                      document.getElementById("fd_3ded07af4e64c6").value,
                      document.getElementById("fd_3ded08386a01d2").value,
                      document.getElementById("fd_3ded0898e10da4").value
                    );
                  });
                  AttachXFormValueChangeEventById("fd_3ded08386a01d2", function(value, rowNum, parentRowNum){
                    hideAll();
                    judgeMethod(
                      document.getElementById("fd_3ded07af4e64c6").value,
                      value,
                      document.getElementById("fd_3ded0898e10da4").value
                    );
                  });
                </script>
              </xform:editShow>
            '>
          </LABEL>
        </DIV>
      `
    });

    const drafted = draftMkScriptsFromSourceScripts(scripts);
    const mappedActions = drafted.actions.filter((action) => action.translationStatus === "mapped");
    assert.equal(mappedActions.length, 2);
    assert.equal(drafted.actions.some((action) => action.translationStatus === "needs_review"), false);
    for (const action of mappedActions) {
      assert.equal(action.coverage.status, "translated");
      assert.doesNotMatch(action.function, /setFieldAttr\(rowMarker/);
      assert.match(action.function, /MKXFORM\.setFieldAttr\("fd_zdpp_row"/);
      assert.match(action.function, /MKXFORM\.setFieldAttr\("fd_jjzlsj_row"/);
    }
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
