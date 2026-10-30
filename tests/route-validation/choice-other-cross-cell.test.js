import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";
import { withCrossCellOtherReveal } from "../../src/executor/persistence/choice-other-cross-cell.js";

const fixture = "tests/fixtures/route-validation/choice-other-cross-cell/choice-other-cross-cell_SysFormTemplate.xml";
it("recognizes a bound Other caption and input in adjacent source cells", () => {
  const source = cleanSourceFile(fixture), choice = source.form.controls.find(field => field.id === "fd_choice");
  assert.equal(choice.sourceProps.otherTextCompanion?.id, "fd_other_text");
  assert.equal(choice.sourceProps.otherTextCompanion?.captionId, "fd_other_caption");
  assert.equal(choice.sourceProps.otherTextCompanion?.crossCell?.version, 1);
  const draft = draftSourceDraft(source), toggle = draft.form.fields.find(field => field.id === "fd_other_caption");
  assert.equal(toggle.componentId, "xform-checkbox");
  assert.equal(draft.form.fields.find(field => field.id === "fd_choice").otherPresentation?.optionValue, "selected");
  assert.equal(draft.form.fields.find(field => field.id === "fd_other_text").props.defaultValue.value, "seed_under_score");
  const prepared = prepareSample(draft); assert.equal(prepared.verify(prepared.update).ok, true);
});
it("carries the source-bound cross-cell presentation through the fake route", async () => {
  const result = await runRouteCase("cross-cell-other-reveal-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.readback.partitions.form, "verified");
});

it("only changes display state and fails open for noneditable or ambiguous controls", () => {
  const draft = draftSourceDraft(cleanSourceFile(fixture)), config = xformConfig(prepareSample(draft).update);
  const action = JSON.parse(config.attribute.formAttr).controlAction.global.onLoad[0];
  assert.ok(action.migrationActions.some(item => item.id === "mk-choice-other-cross-cell-v1"));
  const displayAction = withCrossCellOtherReveal({ actions: [] }, draft.form, prepareSample(draft).update.fdTableName).actions[0];
  const nodes = {}, trigger = { disabled: false, readOnly: false }, note = { disabled: false, readOnly: false }, state = {}, subscriptions = [], writes = [];
  const noteRoot = { querySelector: () => note, setAttribute: (key, value) => { state[key] = value; }, removeAttribute: key => { delete state[key]; } };
  const triggerRoot = { querySelector: () => trigger };
  const document = { head: { appendChild: node => { nodes[node.id] = node; } }, documentElement: {},
    getElementById: id => nodes[id], createElement: () => ({}),
    querySelectorAll: selector => selector.includes("fd_other_caption") ? [triggerRoot] : selector.includes("fd_other_text") ? [noteRoot] : [] };
  let value = [], attr = 2;
  const MKXFORM = { MKXFORM_DATA_CONTAINER: {}, $$FORM: { current: {} }, getValue: ref => ref.endsWith("fd_other_text") ? "" : value,
    getFieldAttr: () => attr, onChange: (ref, callback) => subscriptions.push({ ref, callback }), setValue: (...args) => writes.push(args) };
  runInNewContext(`(${displayAction.function})`, { MKXFORM, document, requestAnimationFrame: callback => callback() })({});
  assert.equal(state["data-mk-cross-other"], "closed"); assert.equal(subscriptions.length, 1);
  value = ["selected"]; subscriptions.at(-1).callback(value); assert.equal(state["data-mk-cross-other"], "open");
  value = []; subscriptions.at(-1).callback(value); assert.equal(state["data-mk-cross-other"], "closed");
  trigger.disabled = true; subscriptions.at(-1).callback(value); assert.equal(state["data-mk-cross-other"], undefined);
  trigger.disabled = false; note.readOnly = true; subscriptions.at(-1).callback(value); assert.equal(state["data-mk-cross-other"], undefined);
  note.readOnly = false; attr = 3; subscriptions.at(-1).callback(value); assert.equal(state["data-mk-cross-other"], undefined);
  attr = undefined; subscriptions.at(-1).callback(value); assert.equal(state["data-mk-cross-other"], undefined);
  attr = 2;
  note.readOnly = false; value = ["unexpected"]; subscriptions.at(-1).callback(value); assert.equal(state["data-mk-cross-other"], undefined);
  assert.deepEqual(writes, [], "conditional visibility must never write business values");
});

it("shows the adjacent explanation only when selected without clearing its value", {
  skip: process.env.MK_LAYOUT_BROWSER_TESTS !== "1"
}, async () => {
  const { chromium } = await import(process.env.MK_LAYOUT_PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.MK_LAYOUT_BROWSER_PATH });
  try {
    const page = await browser.newPage(); await page.route("**/*", route => route.abort());
    const form = draftSourceDraft(cleanSourceFile(fixture)).form;
    const action = withCrossCellOtherReveal({ actions: [] }, form, "mk_model_test").actions[0];
    await page.setContent('<div data-id="mk_model_test.fd_other_caption"><input id="toggle" type="checkbox"></div>' +
      '<div data-id="mk_model_test.fd_other_text"><input id="note" value=""></div>');
    await page.evaluate(code => {
      let value = []; const listeners = [];
      window.MKXFORM = { MKXFORM_DATA_CONTAINER: {}, $$FORM: { current: {} }, getValue: ref => ref.endsWith("fd_other_text") ? document.getElementById("note").value : value,
        getFieldAttr: () => 2, onChange: (_ref, fn) => listeners.push(fn) };
      document.getElementById("toggle").addEventListener("change", event => {
        value = event.target.checked ? ["selected"] : []; listeners.forEach(fn => fn(value));
      });
      (0, eval)(`(${code})`)({});
    }, action.function);
    const toggle = page.locator("#toggle"), note = page.locator("#note");
    assert.equal(await note.isVisible(), false);
    await toggle.check(); assert.equal(await note.isVisible(), true);
    await note.fill("  retained_under_score🙂  ");
    await toggle.uncheck(); assert.equal(await note.isVisible(), false); assert.equal(await note.inputValue(), "  retained_under_score🙂  ");
    await toggle.check(); assert.equal(await note.isVisible(), true); assert.equal(await note.inputValue(), "  retained_under_score🙂  ");
    await toggle.uncheck(); await note.evaluate(node => { node.readOnly = true; });
    assert.equal(await note.isVisible(), true, "read-only data remains visible");
    await note.evaluate(node => { node.readOnly = false; const marker = document.createElement("div"); marker.className = "ele-xform-fieldset-required"; node.parentElement.appendChild(marker); });
    assert.equal(await note.isVisible(), true, "required data remains reachable");
    await page.setContent('<div data-id="mk_model_test.fd_other_caption"><input id="toggle" type="checkbox"></div>' +
      '<div data-id="mk_model_test.fd_other_text"><input id="note" value="historical_value"></div>');
    await page.evaluate(code => {
      let value = []; const listeners = [];
      window.MKXFORM = { MKXFORM_DATA_CONTAINER: {}, $$FORM: { current: {} }, getValue: ref => ref.endsWith("fd_other_text") ? document.getElementById("note").value : value,
        getFieldAttr: () => 2, onChange: (_ref, fn) => listeners.push(fn) };
      document.getElementById("toggle").addEventListener("change", event => { value = event.target.checked ? ["selected"] : []; listeners.forEach(fn => fn(value)); });
      (0, eval)(`(${code})`)({});
    }, action.function);
    assert.equal(await note.isVisible(), true, "an existing explanation cannot be hidden by an uninitialized toggle");
    await toggle.check(); await toggle.uncheck(); assert.equal(await note.isVisible(), false);
    assert.equal(await note.inputValue(), "historical_value");
  } finally { await browser.close(); }
});
it("does not infer a cross-cell relation from unrelated, ambiguous or runtime-mismatched fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "other-cross-cell-"));
  try {
    const xml = readFileSync(fixture, "utf8"), variants = [
      xml.replaceAll("其他资质复印件", "其他合同"),
      xml.replaceAll('_label_bind_id:"fd_other_caption"', '_label_bind_id:"unrelated"'),
      xml.replace('&lt;td row="0" column="2"&gt;&lt;label id="fd_other_caption"', '&lt;td row="1" column="2"&gt;&lt;label id="fd_other_caption"'),
      xml.replace('法人身份证|B', '其他|B')
    ];
    for (const [i, value] of variants.entries()) {
      assert.notEqual(value, xml); const file = join(dir, `negative-${i}_SysFormTemplate.xml`); writeFileSync(file, value);
      assert.equal(cleanSourceFile(file).form.controls.find(field => field.id === "fd_choice").sourceProps.otherTextCompanion, undefined);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("does not replace a cross-cell caption when a source script owns the explanation", () => {
  const dir = mkdtempSync(join(tmpdir(), "other-cross-script-"));
  try {
    const xml = readFileSync(fixture, "utf8").replace('&lt;/table&gt;</string></void></object></java>',
      '&lt;/table&gt;&lt;script&gt;SetXFormFieldValueById("fd_other_text","scripted");&lt;/script&gt;</string></void></object></java>');
    const file = join(dir, "scripted_SysFormTemplate.xml"); writeFileSync(file, xml);
    const source = cleanSourceFile(file), draft = draftSourceDraft(source);
    assert.equal(source.form.controls.find(field => field.id === "fd_choice").sourceProps.otherTextCompanion?.id, "fd_other_text");
    assert.equal(draft.form.fields.some(field => field.sourceProps?.choiceOtherToggle), false);
    assert.equal(draft.form.fields.some(field => field.otherPresentation), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
