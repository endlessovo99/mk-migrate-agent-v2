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
    assert.deepEqual(scripts.actions[0], {
      id: "required-toggle.script.1.event.1",
      name: "onChange",
      event: "onChange",
      scope: "control",
      controlId: "fd_seal_type",
      runWhen: { viewStatusIn: ["add", "edit"] },
      function: "function onChange(value, rowNum, parentRowNum) {\n  const required = String(value || \"\").indexOf(\"quote\") >= 0\n  MKXFORM.setFieldAttr(\"fd_amount\", required ? 3 : 6)\n}",
      sourceRefs: ["source.form.jsp.required-toggle.script.1"],
      branchProvenance: {
        version: 3,
        event: "onChange",
        sourceRef: "source.form.jsp.required-toggle.script.1",
        status: "proven",
        conditions: [{
          kind: "contains",
          value: "quote",
          origin: "event:value",
          transforms: [],
          predicate: "indexOf"
        }]
      },
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [{
        source: "AttachXFormValueChangeEventById + set_required/set_not_required",
        target: "MKXFORM.setFieldAttr",
        basis: "semantic-translation",
        reviewRequired: false
      }],
      unmappedFunctions: ["console.log", "$"]
    });
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
