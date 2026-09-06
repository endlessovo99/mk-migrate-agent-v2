import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftMkScriptsFromSourceScripts } from "../../src/translator/sysform-jsp-scripts.js";

const attachJavascript = [
  'AttachXFormValueChangeEventById("fd_select_person.id",function(value,domElement){',
  "  var pId=value[0];",
  '  var toIDs=[{name:"fdParentOrgName",id:"extendDataFormInfo.value(fd_person_org)"},{name:"fdParentName",id:"extendDataFormInfo.value(fd_person_dept)"}];',
  "  var kmssdata = new KMSSData();",
  "  kmssdata.UseCache = false;",
  '  kmssdata.AddBeanData(Data_GetOrgPersonBeanNameByKey("\'"+pId+"\'","fdId:fdName:hbmParentOrg.fdName:hbmParent.fdName:fdLoginName:fdMobileNo:fdEmail"));',
  "  $.ajax({",
  '    url:"/sys/organization/sys_org_person/chgPersonInfo.do?method=findCompByChildId",',
  "    data:{fdId:pId},",
  '    type:"post",',
  "    cache:false,",
  '    dataType:"json",',
  "    success:function(data) {",
  '      $("input[name=\'extendDataFormInfo.value(fd_person_org)\']").val(data.fdName);',
  "    },",
  '    error:function() { alert("异常！"); }',
  "  });",
  "});"
].join("\n");

describe("person company ajax hydration omission", () => {
  it("omits AttachXForm id-suffix company ajax when every write target is missing or not a text input", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [{
        id: "jsp_person_org.script.1",
        sourceRef: "source.form.jsp.jsp_person_org.script.1",
        javascript: attachJavascript,
        functionAudit: { matched: [], violations: [{ name: "$.ajax" }, { name: "alert" }] }
      }]
    }, {
      form: {
        fields: [
          { id: "fd_select_person", title: "请假人", type: "text", componentId: "xform-address", props: {} },
          { id: "fd_person_dept", title: "所在部门", type: "text", componentId: "xform-address", props: {} }
        ]
      }
    });

    const action = scripts.actions[0];
    assert.equal(action.translationStatus, "omitted");
    assert.equal(action.function, "");
    assert.equal(action.functionMappings[0].basis, "legacy-runtime-noop");
    assert.match(action.functionMappings[0].source, /fd_person_org|fd_person_dept|findCompByChildId/u);
    assert.deepEqual(action.coverage, { status: "covered", nativeRules: [], residuals: [] });
    assert.equal(action.unmappedFunctions.length, 0);
  });

  it("does not omit company ajax when a write target is a present text input", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [{
        id: "jsp_person_org.script.1",
        sourceRef: "source.form.jsp.jsp_person_org.script.1",
        javascript: attachJavascript,
        functionAudit: { matched: [], violations: [{ name: "$.ajax" }, { name: "alert" }] }
      }]
    }, {
      form: {
        fields: [
          { id: "fd_select_person", title: "请假人", type: "text", componentId: "xform-address", props: {} },
          { id: "fd_person_org", title: "所在公司", type: "text", componentId: "xform-input", props: {} },
          { id: "fd_person_dept", title: "所在部门", type: "text", componentId: "xform-address", props: {} }
        ]
      }
    });

    assert.equal(
      scripts.actions.some((action) =>
        action.functionMappings?.some((mapping) => mapping.basis === "legacy-runtime-noop")
      ),
      false
    );
    assert.equal(
      scripts.warnings.some((warning) =>
        warning.code === "script.control_unresolved" && warning.controlId === "fd_select_person.id"
      ),
      true
    );
  });
});
