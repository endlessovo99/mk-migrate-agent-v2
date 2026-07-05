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
