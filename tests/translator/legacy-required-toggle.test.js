import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftMkScriptsFromSourceScripts } from "../../src/translator/sysform-jsp-scripts.js";

describe("legacy required toggle scripts", () => {
  it("maps a value-change required toggle to MKXFORM.setFieldAttr", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [source(`
        AttachXFormValueChangeEventById("fd_seal_type", function(value, domElement){
          console.log('selected', value);
          set_not_required('fd_amount')
          if(value.indexOf('quote')>=0){
            set_required('fd_amount');
          }else{
            set_not_required('fd_amount')
          }
        });

        function set_required(child_id){
          $("[name='extendDataFormInfo.value("+child_id+")']").attr("validate","required");
          $("[name='extendDataFormInfo.value("+child_id+")']").parent().append("<sapn class='txtstrong'>*</span>");
        }

        function set_not_required(child_id){
          $("[name='extendDataFormInfo.value("+child_id+")']").attr("validate","");
          $("[name='extendDataFormInfo.value("+child_id+")']").parent().find(".txtstrong").hide();
        }
      `)]
    }, { form: form() });

    assert.equal(scripts.actions.length, 1);
    const action = scripts.actions[0];
    assert.equal(action.id, "required-toggle.script.1.event.1");
    assert.equal(action.event, "onChange");
    assert.equal(action.scope, "control");
    assert.equal(action.controlId, "fd_seal_type");
    assert.deepEqual(action.runWhen, { viewStatusIn: ["add", "edit"] });
    assert.equal(action.function, "function onChange(value, rowNum, parentRowNum) {\n  const required = String(value || \"\").indexOf(\"quote\") >= 0\n  MKXFORM.setFieldAttr(\"fd_amount\", required ? 3 : 6)\n}");
    assert.equal(action.translationStatus, "mapped");
    assert.equal(action.deterministicBranchProof?.basis, "deterministic-required-field-toggle");
    assert.deepEqual(action.coverage, { status: "translated", nativeRules: [], residuals: [] });
    assert.deepEqual(action.functionMappings, [{
      source: "set_required/set_not_required field helper",
      target: "MKXFORM.getValue/setFieldAttr",
      basis: "deterministic-required-field-toggle",
      reviewRequired: false
    }]);
    assert.deepEqual(action.semanticHints?.coveredLegacyFunctions, ["console.log", "$"]);
    assert.deepEqual(action.unmappedFunctions, []);
  });

  it("keeps the script reviewable when the target field is not in the form", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [source(`
        AttachXFormValueChangeEventById("fd_seal_type", function(value){
          if(value.indexOf('quote')>=0){ set_required('fd_missing'); }
          else{ set_not_required('fd_missing') }
        });
        function set_required(child_id){ $("[name='extendDataFormInfo.value("+child_id+")']").attr("validate","required"); }
        function set_not_required(child_id){ $("[name='extendDataFormInfo.value("+child_id+")']").attr("validate",""); }
      `)]
    }, { form: form() });

    assert.equal(scripts.actions[0].translationStatus, "needs_review");
    assert.equal(scripts.actions[0].deterministicBranchProof, undefined);
  });
});

function source(javascript) {
  return {
    id: "required-toggle.script.1",
    sourceRef: "source.form.jsp.required-toggle.script.1",
    displayGate: "xform:editShow",
    javascript,
    functionAudit: {
      matched: [{ name: "AttachXFormValueChangeEventById", occurrences: [{ index: 0 }] }],
      violations: [{ name: "console.log" }, { name: "$" }]
    }
  };
}

function form() {
  return {
    fields: [
      { id: "fd_seal_type", title: "用印类型", type: "multiSelect", componentId: "xform-checkbox", props: {} },
      { id: "fd_amount", title: "报价金额", type: "number", componentId: "xform-number", props: {} }
    ]
  };
}
