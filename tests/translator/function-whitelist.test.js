import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  auditFunctionWhitelist,
  extractFunctionCalls,
  loadFunctionWhitelist
} from "../../src/translator/function-whitelist.js";

const whitelistPath = "tests/fixtures/function-whitelist.json";

describe("function whitelist", () => {
  it("loads whitelist mappings from JSON", () => {
    const whitelist = loadFunctionWhitelist(whitelistPath);

    assert.equal(whitelist.version, "2026-07-06.v2");
    assert.equal(whitelist.externalSourcePath, whitelistPath);
    assert.equal(whitelist.entries.length, 4);
    assert.equal(whitelist.byName.get("DocList_AddRow")?.mkFunction, "MKXFORM.addRow(表单ID, rowValue)");
  });

  it("extracts source function calls without framework noise", () => {
    const calls = extractFunctionCalls(`
      Com_AddEventListener(window, "load", function(){
        setTimeout(function() {
          DocList_AddRow(document.getElementById("detail"));
          element.style.background = "url(style/img/br.png) no-repeat";
          $("tr").find("td").each(function(){});
          UnknownLegacyFunction();
        }, 500);
      });
    `);

    assert.deepEqual(calls.map((call) => call.name), [
      "Com_AddEventListener",
      "DocList_AddRow",
      "document.getElementById",
      "UnknownLegacyFunction"
    ]);
  });

  it("ignores local helper functions, string literals, comments, and common instance methods", () => {
    const calls = extractFunctionCalls(`
      function localHelper() {
        document.getElementsByName("extendDataFormInfo.value(fd_detail.0.fd_field)");
        document.getElementsByName(&amp;quot;extendDataFormInfo.value(fd_detail.0.fd_field)&amp;quot;);
        value.indexOf("sb");
        item.setAttribute("validate", "required number min(0)");
        item.setAttribute("validate", "required number min(0) scaleLength(0)");
        // CommentedLegacyFunction();
      }
      localHelper();
      const anotherHelper = function() {
        document.getElementById("target");
      };
      anotherHelper();
      Designer_Control_Right_SetModeCellValue(this);
      UnknownLegacyFunction();
    `);

    assert.deepEqual(calls.map((call) => call.name), [
      "document.getElementById",
      "document.getElementsByName",
      "UnknownLegacyFunction"
    ]);
  });

  it("ignores legacy Landray context default expressions", () => {
    const calls = extractFunctionCalls(`
      <INPUT value=$申请人$.getFdName()>
      <INPUT value=$部门$.getFdName()>
      <INPUT value=$docCreator$.getFdName()>
      <INPUT value=$fdDepartment$.getFdName()>
      <INPUT value=$组织架构.当前用户$().getFdName()>
      UnknownLegacyFunction();
    `);

    assert.deepEqual(calls.map((call) => call.name), ["UnknownLegacyFunction"]);
  });

  it("reports only calls outside the whitelist", () => {
    const whitelist = loadFunctionWhitelist(whitelistPath);
    const audit = auditFunctionWhitelist(`
      Com_AddEventListener(window, "load", function(){
        DocList_AddRow(document.getElementById("detail"));
        UnknownLegacyFunction();
      });
    `, whitelist, { path: "/fdDesignerHtml" });

    assert.deepEqual(audit.matched.map((item) => item.name), [
      "Com_AddEventListener",
      "DocList_AddRow",
      "document.getElementById"
    ]);
    assert.deepEqual(audit.violations.map((item) => item.name), ["UnknownLegacyFunction"]);
  });
});
