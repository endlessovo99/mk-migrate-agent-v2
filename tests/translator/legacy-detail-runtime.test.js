import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftMkScriptsFromSourceScripts } from "../../src/translator/sysform-jsp-scripts.js";

describe("legacy detail-table runtime scripts", () => {
  it("omits legacy detail runtime wiring and maps the default-row action", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [
        source("include", "Com_IncludeFile('doclist.js');"),
        source("register", "DocList_Info.push('TABLE_DL_fd_fjmx');"),
        source("default-row", "Com_AddEventListener(window, 'load', function(){ setTimeout(function() {for (var i = 0; i < 1; i ++) {DocList_AddRow(document.getElementById('TABLE_DL_fd_fjmx'))};}, 500);});", "xform:editShow"),
        source("width", "$(function(){var tb=document.getElementById('TABLE_DL_fd_fjmx');var totalWidth=0;var tds=$(tb).find(\"tr[type='titleRow']\").children();var hasPercent=false;tds.each(function(){if(!this.width||this.width+''.indexOf('%')>=0){totalWidth+=$(this).width();hasPercent=true;}else{totalWidth+=parseInt(this.width);}});var tdWidth=$(tb).parents('td').width();if(!hasPercent&&totalWidth>tdWidth)$(tb).css('width',totalWidth+'px');var tb_div=document.getElementById('TABLE_DL_fd_fjmx_div');$(tb_div).css('width','100%');});")
      ]
    }, { form: formWithDetailTable() });

    assert.deepEqual(scripts.actions.map((action) => ({
      translationStatus: action.translationStatus,
      function: action.function,
      coverage: action.coverage
    })), [
      omittedAction(),
      omittedAction(),
      {
        translationStatus: "mapped",
        function: "function onLoad() {\n  MKXFORM.addRow('fd_fjmx', {})\n}",
        coverage: { status: "translated", nativeRules: [], residuals: [] }
      },
      omittedAction()
    ]);
    assert.deepEqual(scripts.actions[2].functionMappings, [{
      source: "DocList_AddRow",
      target: "MKXFORM.addRow",
      basis: "semantic-translation",
      reviewRequired: false
    }]);
  });

  it("does not omit arbitrary DOM scripts", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [source("other-dom", "$(function(){document.getElementById('other').style.width='100%';});")]
    }, { form: formWithDetailTable() });

    assert.equal(scripts.actions[0].translationStatus, "needs_review");
  });
});

function source(id, javascript, displayGate) {
  return {
    id: `${id}.script.1`,
    sourceRef: `source.form.jsp.${id}.script.1`,
    displayGate,
    javascript,
    functionAudit: { matched: [], violations: [] }
  };
}

function formWithDetailTable() {
  return {
    fields: [{
      id: "fd_fjmx",
      title: "附件明细",
      type: "detailTable",
      componentId: "xform-detail-table",
      props: {},
      columns: [{ id: "fd_name", title: "名称", type: "text", componentId: "xform-input", props: {} }]
    }]
  };
}

function omittedAction() {
  return {
    translationStatus: "omitted",
    function: "",
    coverage: { status: "covered", nativeRules: [], residuals: [] }
  };
}
