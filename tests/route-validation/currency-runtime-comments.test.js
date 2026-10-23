import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapXmlStringPuts } from "../../src/translator/xml-utils.js";
import { prepareSample, formAttr } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/currency-runtime-comments/currency-runtime-comments_SysFormTemplate.xml";
const include = "<script>Com_IncludeFile('chinaValue_script.js','../sys/xform/designer/chinaValue/');</script>";

it("converts currency on load and amount changes when runtime import follows JSP comments", () => {
  const dsl = draftSourceDraft(cleanSourceFile(fixture));
  const prepared = prepareSample(dsl);
  const actions = formAttr(prepared.update).controlAction;
  const state = { fd_amount: 111, fd_upper: "" };
  const MKXFORM = {
    viewStatus: "add",
    getValue: id => state[id],
    setValue: (id, value) => { state[id] = value; }
  };
  for (const action of actions.global.onLoad || []) execute(action, MKXFORM)();
  assert.equal(state.fd_upper, "壹佰壹拾壹元整");

  state.fd_amount = 23.45;
  for (const action of actions.control["mk_model_test.fd_amount"]?.onChange || []) {
    execute(action, MKXFORM)(23.45);
  }
  assert.equal(state.fd_upper, "贰拾叁元肆角伍分");
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("ignores scriptlets inside a complete JSP comment without changing import scope", () => {
  const draft = variant(jsp => jsp.replace("<%-- 基准行 --%>", "<%-- 基准行 <% if (ignored) { %> --%>"));
  const actions = currencyActions(draft);
  const state = { fd_amount: 111 };
  execute(actions.find(action => action.event === "onLoad"), {
    getValue: id => state[id],
    setValue: (id, value) => { state[id] = value; }
  })();
  assert.equal(state.fd_upper, "壹佰壹拾壹元整");
});

for (const [name, change] of [
  ["a real surrounding JSP condition", jsp => `<% if (enabled) { %>${jsp}<% } %>`],
  ["unknown JSP code before the import", jsp => `<% changeAmount(); %>${jsp}`],
  ["an import inside a JSP comment", jsp => jsp.replace(include, `<%-- ${include} --%>`)],
  ["an unterminated JSP comment before the import", jsp => jsp.replace(include, `<%-- ${include}`)]
]) it(`does not promote currency runtime import with ${name}`, () => {
  assert.deepEqual(currencyActions(variant(change)), []);
});

function currencyActions(draft) {
  return draft.scripts.actions.filter(action => action.functionMappings?.some(mapping =>
    mapping.basis === "deterministic-china-value-runtime"
  ));
}

function variant(change) {
  const props = parseRootHashMapXmlStringPuts(readFileSync(fixture, "utf8"));
  props.fdDisplayJsp = change(props.fdDisplayJsp);
  const directory = mkdtempSync(join(tmpdir(), "currency-runtime-comments-"));
  const encode = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    const file = join(directory, "currency_SysFormTemplate.xml");
    writeFileSync(file, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") +
      "</object></java>");
    return draftSourceDraft(cleanSourceFile(file));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function execute(action, MKXFORM) {
  const name = action.function.match(/^function\s+(\w+)/)[1];
  return Function("MKXFORM", `${action.function}; return ${name};`)(MKXFORM);
}
