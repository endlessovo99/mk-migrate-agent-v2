import assert from "node:assert/strict";
import { it } from "node:test";
import { runInNewContext } from "node:vm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeChoiceLayoutHtml } from "../helpers/native-choice-layout.js";
import { runRouteCase } from "./run-route-case.js";

const existing = "tests/fixtures/route-validation/choice-other-wrap/choice-other-wrap_SysFormTemplate.xml";
const generated = "tests/fixtures/route-validation/checkbox-other-compatible/compatible_SysFormTemplate.xml";
const select = "tests/fixtures/route-validation/choice-other-select/choice-other-select_SysFormTemplate.xml";
const styled = "tests/fixtures/route-validation/choice-other-styled/choice-other-styled_SysFormTemplate.xml";

it("proves a styled source region without changing its caption or unrelated script", () => {
  const source = cleanSourceFile(styled), draft = draftSourceDraft(source);
  const choice = source.form.controls.find(field => field.id === "fd_kind");
  assert.equal(choice.sourceProps.otherPairContext?.version, 1);
  assert.ok(choice.sourceProps.otherPairContext.ancestorIds.includes("layout"));
  assert.ok(choice.sourceProps.otherPairContext.inlineScriptDigests.every(digest => /^[a-f0-9]{64}$/.test(digest)));
  assert.equal(Object.hasOwn(choice.sourceProps.otherPairContext, "inlineScripts"), false, "source context must not duplicate raw scripts");
  assert.equal(draft.form.fields.find(field => field.id === "fd_kind").otherPresentation?.mode, "reveal-on-selection");
  assert.equal(draft.form.fields.find(field => field.id === "fd_title").dataOnly === true, false);
  assert.equal(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, true);
  const prepared = prepareSample(draft); assert.equal(prepared.verify(prepared.update).ok, true);
});

it("carries the styled-region proof through the guarded fake route", async () => {
  const result = await runRouteCase("styled-other-reveal-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.readback.partitions.form, "verified");
});

it("does not grant a styled-region proof for ambiguous runtime bindings or an ancestor-changing script", () => {
  const dir = mkdtempSync(join(tmpdir(), "other-region-negative-"));
  try {
    const original = readFileSync(styled, "utf8");
    const target = '&lt;xform:xtext property="extendDataFormInfo.value(fd_note)" style="width:120px"/&gt;';
    assert.equal(original.split(target).length, 2);
    const variants = [
      original.replace(target, target + target),
      original.replace(target, target.replace("xform:xtext", "xform:hidden")),
      original.replace(target, target.replace('style="width:120px"', 'style="display:none"')),
      original.replace("function harmless(){return true;}", 'document.getElementById("layout").style.display="none";')
    ];
    for (const [index, xml] of variants.entries()) {
      const path = join(dir, `negative-${index}_SysFormTemplate.xml`); writeFileSync(path, xml);
      const source = cleanSourceFile(path), draft = draftSourceDraft(source);
      assert.equal(draft.form.fields.some(field => field.otherPresentation), false);
      assert.ok(draft.review.warnings.some(item => item.code === "source.form.choice_other_reveal_needs_manual"));
    }
    const missingProgram = cleanSourceFile(styled);
    missingProgram.scripts = { sources: [], fragments: [] };
    assert.equal(draftSourceDraft(missingProgram).form.fields.some(field => field.otherPresentation), false,
      "a source region cannot claim safety without every captured runtime program");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("blocks an unproven detail select/text compound before any transport", async () => {
  const result = await runRouteCase("select-other-option-detail-blocked-before-transport");
  assert.equal(result.review.stage, "agent-review.input");
  assert.equal(result.execution, undefined);
  assert.deepEqual(result.transcript, []);
});

it("completes the guarded fake route for the select Other presentation", async () => {
  const result = await runRouteCase("select-other-reveal-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.readback.partitions.form, "verified");
});

it("recognizes the source-backed select Other and its separately stored explanation", () => {
  const source = cleanSourceFile(select), draft = draftSourceDraft(source);
  const original = source.form.controls.find(field => field.id === "fd_payment");
  const choice = draft.form.fields.find(field => field.id === "fd_payment");
  assert.deepEqual(original.sourceProps.otherTextCompanion, { id: "fd_note", otherRequired: false, optionValue: "C", optionLabel: "其他" });
  assert.equal(choice.componentId, "xform-select");
  assert.equal(choice.otherPresentation?.optionValue, "C");
  assert.deepEqual(choice.props.options, original.options);
  assert.equal(draft.form.fields.find(field => field.id === "fd_note").props.defaultValue.value, "  keep_under_score🙂  ");
  assert.equal(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, true);
  const prepared = prepareSample(draft);
  const observed = prepared.verify(prepared.update);
  assert.equal(observed.ok, true);
  assert.ok(observed.form.layoutRows.flatMap(row => row.cells.flatMap(cell => cell.contentFlow?.companions || []))
    .some(group => group.mode === "select" && group.revealOnSelection === true), "the reveal must survive native layout readback");
  const changed = structuredClone(prepared.update), config = xformConfig(changed), attr = JSON.parse(config.attribute.formAttr);
  attr.controlAction.global.onLoad[0].function += "\n/* changed */";
  config.attribute.formAttr = JSON.stringify(attr); changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  assert.equal(prepared.verify(changed).ok, false, "readback must detect loss or alteration of the select listener");
});

it("does not associate an unrelated same-cell text with a select Other option", () => {
  const dir = mkdtempSync(join(tmpdir(), "other-select-negative-"));
  try {
    const input = join(dir, "negative_SysFormTemplate.xml");
    writeFileSync(input, readFileSync(select, "utf8").replaceAll("付款方式-其他", "合同名称"));
    const source = cleanSourceFile(input), draft = draftSourceDraft(source);
    assert.equal(source.form.controls.find(field => field.id === "fd_payment").sourceProps.otherTextCompanion, undefined);
    assert.equal(draft.form.fields.some(field => field.otherPresentation), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("recognizes an Other select option even when it is not the last option", () => {
  const source = cleanSourceFile(select), choice = source.form.controls.find(field => field.id === "fd_payment");
  choice.options = [choice.options[2], choice.options[0], choice.options[1]];
  const draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.find(field => field.id === "fd_payment").otherPresentation?.optionValue, "C");
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("projects an onLoad select observer that changes presentation without writing business values", () => {
  const draft = draftSourceDraft(cleanSourceFile(select)), prepared = prepareSample(draft);
  const config = xformConfig(prepared.update), attr = JSON.parse(config.attribute.formAttr);
  const onLoad = attr.controlAction.global.onLoad?.[0];
  assert.ok(onLoad?.migrationActions?.some(action => action.id === "mk-choice-other-select-reveal-v1"));
  const view = JSON.parse(config.viewModel[0].fdConfig);
  const find = node => {
    if (!node || typeof node !== "object") return undefined;
    if (node.controlProps?.style?.["--mk-choice-other-kind"] === "select") return node;
    for (const child of node.children || []) { const match = find(child); if (match) return match; }
  };
  const group = view.view.render.desktop.map(find).find(Boolean);
  assert.ok(group);
  const state = {}, subscriptions = [], writes = [];
  const control = { disabled: false, getAttribute: () => null };
  const choice = { querySelector: selector => selector.startsWith("select") ? control : null };
  const element = { querySelector: () => choice, setAttribute: (key, value) => { state[key] = value; }, removeAttribute: key => { delete state[key]; } };
  let nodes = [element];
  const document = { querySelectorAll: selector => selector === `.${group.controlProps.className}` ? nodes : [], documentElement: {} };
  const MKXFORM = { MKXFORM_DATA_CONTAINER: {}, $$FORM: { current: {} }, getValue: () => undefined,
    setValue: (...args) => writes.push(args), onChange: (ref, callback) => subscriptions.push({ ref, callback }) };
  const onLoadFunction = runInNewContext(`(${onLoad.function})`, { MKXFORM, document, requestAnimationFrame: callback => callback() });
  onLoadFunction({});
  assert.equal(subscriptions.length, 1);
  assert.equal(state["data-mk-other-state"], "closed");
  subscriptions[0].callback("C");
  assert.equal(state["data-mk-other-state"], "open");
  subscriptions[0].callback("A");
  assert.equal(state["data-mk-other-state"], "closed");
  subscriptions[0].callback(undefined);
  assert.equal(state["data-mk-other-state"], "closed", "an unselected native field may return undefined");
  subscriptions[0].callback({ unexpected: true });
  assert.equal(state["data-mk-other-state"], undefined, "unsupported native values fail open");
  control.disabled = true; subscriptions[0].callback("A");
  assert.equal(state["data-mk-other-state"], undefined, "a read-only select leaves its existing explanation visible");
  control.disabled = false;
  const duplicate = {};
  nodes = [element, { setAttribute: (key, value) => { duplicate[key] = value; }, removeAttribute: key => { delete duplicate[key]; } }];
  subscriptions[0].callback("A");
  assert.equal(state["data-mk-other-state"], undefined, "ambiguous form instances do not hide either explanation");
  nodes = [element]; subscriptions[0].callback("A");
  MKXFORM.$$FORM.current = {};
  subscriptions[0].callback("C");
  assert.equal(state["data-mk-other-state"], "closed", "a stale form callback cannot affect the new form");
  assert.deepEqual(writes, []);
});

it("updates a select group mounted later and stops observing a replaced form", () => {
  const draft = draftSourceDraft(cleanSourceFile(select)), config = xformConfig(prepareSample(draft).update);
  const onLoad = JSON.parse(config.attribute.formAttr).controlAction.global.onLoad[0].function;
  const view = JSON.parse(config.viewModel[0].fdConfig);
  const find = node => {
    if (!node || typeof node !== "object") return undefined;
    if (node.controlProps?.style?.["--mk-choice-other-kind"] === "select") return node;
    for (const child of node.children || []) { const match = find(child); if (match) return match; }
  };
  const scope = view.view.render.desktop.map(find).find(Boolean).controlProps.className;
  let nodes = [], value, observer, callback; const attrs = {};
  const control = { disabled: false, getAttribute: () => null };
  const choice = { querySelector: selector => selector.startsWith("select") ? control : null };
  const element = { querySelector: () => choice, setAttribute: (key, value) => { attrs[key] = value; }, removeAttribute: key => { delete attrs[key]; } };
  const document = { querySelectorAll: selector => selector === `.${scope}` ? nodes : [], documentElement: {} };
  class Observer { constructor(fn) { this.callback = fn; observer = this; } observe() {} disconnect() { this.disconnected = true; } }
  const MKXFORM = { MKXFORM_DATA_CONTAINER: {}, $$FORM: { current: {} }, getValue: () => value,
    onChange: (_ref, fn) => { callback = fn; } };
  runInNewContext(`(${onLoad})`, { MKXFORM, document, MutationObserver: Observer })({});
  value = "C"; callback(value); nodes = [element];
  observer.callback([{ addedNodes: [{ nodeType: 1, matches: selector => selector === `.${scope}` }], removedNodes: [] }]);
  assert.equal(attrs["data-mk-other-state"], "open");
  value = "A";
  observer.callback([{ addedNodes: [{ nodeType: 1, matches: selector => selector === `.${scope}` }], removedNodes: [] }]);
  assert.equal(attrs["data-mk-other-state"], "closed", "a remounted group reads the current native value");
  MKXFORM.$$FORM.current = {};
  observer.callback([]);
  assert.equal(observer.disconnected, true);
});

for (const fixture of [existing, generated]) {
  it(`projects and verifies a source-bound Other reveal for ${fixture}`, () => {
    const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
    const choice = draft.form.fields.find(field => field.otherPresentation);
    assert.ok(choice, "a proven optional choice/text relationship carries its presentation policy in the DSL");
    assert.equal(checkDraft(draft).ok, true);
    assert.equal(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, true);
    const prepared = prepareSample(draft);
    assert.equal(prepared.verify(prepared.update).ok, true);
    const tampered = structuredClone(prepared.update), config = xformConfig(tampered);
    const view = JSON.parse(config.viewModel[0].fdConfig);
    const visit = node => {
      if (!node || typeof node !== "object") return;
      if (node.controlProps?.style?.["--mk-choice-other-reveal"]) delete node.controlProps.style["--mk-choice-other-reveal"];
      for (const child of node.children || []) visit(child);
    };
    for (const node of view.view.render.desktop) visit(node);
    config.viewModel[0].fdConfig = JSON.stringify(view);
    tampered.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    assert.equal(prepared.verify(tampered).ok, false, "readback must reject loss of the reveal contract");
  });
}

it("does not invent conditional presentation for a required or script-owned explanation", () => {
  const required = cleanSourceFile(existing);
  required.form.controls.find(field => field.id === "fd_note").required = true;
  const requiredDraft = draftSourceDraft(required);
  assert.equal(requiredDraft.form.fields.some(field => field.otherPresentation), false);
  assert.ok(requiredDraft.review.warnings.some(item => item.code === "source.form.choice_other_reveal_needs_manual"));
  const readOnly = cleanSourceFile(existing);
  readOnly.form.controls.find(field => field.id === "fd_note").sourceProps.designerValues.readOnly = "true";
  assert.equal(draftSourceDraft(readOnly).form.fields.some(field => field.otherPresentation), false,
    "a source read-only explanation must not become unreachable");
  const scripted = cleanSourceFile(existing);
  scripted.scripts = { sources: [{ id: "note-owner", sourceRef: "source.note-owner",
    javascript: 'document.getElementById("fd_note").style.display = "none";' }] };
  const scriptedDraft = draftSourceDraft(scripted);
  assert.equal(scriptedDraft.form.fields.some(field => field.otherPresentation), false);
  assert.ok(scriptedDraft.review.warnings.some(item => item.code === "source.form.choice_other_reveal_needs_manual"));
  const ruled = cleanSourceFile(existing);
  ruled.formRules = { linkage: [{ id: "note-required", source: "fd_kind", trigger: "change",
    when: [{ field: "fd_kind", op: "contains", value: "A" }],
    effects: [{ type: "required", target: "fd_note", value: true }],
    else: [{ type: "required", target: "fd_note", value: false }] }] };
  assert.equal(draftSourceDraft(ruled).form.fields.some(field => field.otherPresentation), true,
    "dynamic native required state remains reachable through the visual fallback");
});

it("rejects a forged or redirected Other reveal policy while accepting a retained legacy DSL", () => {
  const source = cleanSourceFile(existing), draft = draftSourceDraft(source);
  const legacy = structuredClone(draft);
  delete legacy.form.fields.find(field => field.otherPresentation).otherPresentation;
  assert.equal(checkTrust(source, createTrustedMigrationDsl(source, legacy, { externalAgentReviewed: true })).ok, true);
  const altered = structuredClone(draft);
  altered.form.fields.find(field => field.otherPresentation).otherPresentation.optionValue = "A";
  assert.equal(checkDraft(altered).ok, false);
  assert.equal(checkTrust(source, createTrustedMigrationDsl(source, altered, { externalAgentReviewed: true })).ok, false);
  const unsafe = cleanSourceFile(existing);
  unsafe.scripts = { sources: [{ id: "note-owner", sourceRef: "source.note-owner",
    javascript: 'document.getElementById("fd_note").style.display = "none";' }] };
  const forged = draftSourceDraft(unsafe);
  forged.form.fields.find(field => field.id === "fd_kind").otherPresentation = structuredClone(draft.form.fields.find(field => field.id === "fd_kind").otherPresentation);
  assert.equal(checkTrust(unsafe, createTrustedMigrationDsl(unsafe, forged, { externalAgentReviewed: true })).ok, false,
    "review cannot introduce presentation over an unproven source script");
});

// Browser-enabled route verification uses local captured native widgets only.
// Default tests never contact NewOA.
it("reveals the source explanation only after choosing Other, without losing its text", {
  skip: process.env.MK_LAYOUT_BROWSER_TESTS !== "1"
}, async () => {
  const { chromium } = await import(process.env.MK_LAYOUT_PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.MK_LAYOUT_BROWSER_PATH });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    const cases = [
      { path: existing, value: "OT", note: "fd_note" },
      { path: generated, value: "selected", note: "fd_other_text" }
    ];
    for (const fixture of cases) for (const scene of ["desktop", "mobile"]) {
      const dsl = draftSourceDraft(cleanSourceFile(fixture.path));
      const prepared = prepareSample(dsl);
      assert.equal(prepared.verify(prepared.update).ok, true);
      await page.setContent(nativeChoiceLayoutHtml(xformConfig(prepared.update), scene));
      const note = page.locator(`input[data-note="${fixture.note}"]`);
      const other = page.locator(`.core-choice[data-value="${fixture.value}"] input`);
      assert.equal(await note.count(), 1, `${fixture.path}/${scene}: independent original field remains rendered`);
      assert.equal(await other.count(), 1, `${fixture.path}/${scene}: one Other selector`);
      assert.equal(await note.isVisible(), false, `${fixture.path}/${scene}: unchecked Other hides its explanation`);
      const ordinary = page.locator('.core-choice[data-value="A"] input');
      await ordinary.check();
      assert.equal(await note.isVisible(), false, `${fixture.path}/${scene}: ordinary options do not reveal Other`);
      await other.check();
      assert.equal(await note.isVisible(), true, `${fixture.path}/${scene}: selecting Other reveals its explanation`);
      await note.fill("  保留_under_score🙂  ");
      await other.uncheck();
      assert.equal(await note.isVisible(), false, `${fixture.path}/${scene}: cancelling Other hides the explanation`);
      assert.equal(await note.inputValue(), "  保留_under_score🙂  ");
      await other.evaluate(input => { input.disabled = true; });
      assert.equal(await note.isVisible(), true, `${fixture.path}/${scene}: a disabled Other keeps saved text visible`);
      await other.evaluate(input => { input.disabled = false; });
      assert.equal(await note.isVisible(), false);
      await note.evaluate(input => { input.readOnly = true; });
      assert.equal(await note.isVisible(), true, `${fixture.path}/${scene}: a read-only explanation remains visible`);
      await note.evaluate(input => { input.readOnly = false; });
      assert.equal(await note.isVisible(), false);
      await page.evaluate(noteId => {
        const note = document.querySelector(`input[data-note="${noteId}"]`);
        const marker = document.createElement("div"); marker.className = "ele-xform-fieldset-required";
        note.closest(".ele-xform-fieldset").appendChild(marker);
      }, fixture.note);
      assert.equal(await note.isVisible(), true, `${fixture.path}/${scene}: a source-required note cannot become unreachable`);
      await page.evaluate(noteId => document.querySelector(`input[data-note="${noteId}"]`)
        .closest(".ele-xform-fieldset").querySelector(".ele-xform-fieldset-required")?.remove(), fixture.note);
      assert.equal(await note.isVisible(), false);
      await other.check();
      assert.equal(await note.isVisible(), true);
      assert.equal(await note.inputValue(), "  保留_under_score🙂  ");
      await page.evaluate(noteId => {
        const note = document.querySelector(`input[data-note="${noteId}"]`);
        const group = note.closest('[class^="mk-choice-other-flow-"]');
        group.querySelectorAll(".mk-choice-other-choice input[type=checkbox], .mk-choice-other-choice input[type=radio]").forEach(input => input.remove());
      }, fixture.note);
      assert.equal(await note.isVisible(), true, `${fixture.path}/${scene}: a read-only native view without controls keeps saved text visible`);
    }
  } finally {
    await browser.close();
  }
});

it("reveals a select explanation from the native value and preserves it when another option is chosen", {
  skip: process.env.MK_LAYOUT_BROWSER_TESTS !== "1"
}, async () => {
  const { chromium } = await import(process.env.MK_LAYOUT_PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.MK_LAYOUT_BROWSER_PATH });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    const draft = draftSourceDraft(cleanSourceFile(select)), prepared = prepareSample(draft);
    const config = xformConfig(prepared.update), onLoad = JSON.parse(config.attribute.formAttr).controlAction.global.onLoad[0].function;
    for (const scene of ["desktop", "mobile"]) {
      await page.setContent(nativeChoiceLayoutHtml(config, scene));
      await page.evaluate(script => {
        let value = null; const callbacks = [];
        window.MKXFORM = { MKXFORM_DATA_CONTAINER: {}, $$FORM: { current: {} }, getValue: () => value,
          onChange: (_ref, callback) => callbacks.push(callback) };
        window.__setChoice = next => { value = next; callbacks.forEach(callback => callback(value)); };
        document.querySelector('select[data-choice="fd_payment"]').addEventListener("change", event => {
          window.__setChoice(event.target.value);
        });
        (0, eval)(`(${script})`)({});
      }, onLoad);
      const note = page.locator('input[data-note="fd_note"]'), choice = page.locator('select[data-choice="fd_payment"]');
      assert.equal(await note.isVisible(), false, `${scene}: empty selection hides the explanation`);
      await choice.selectOption("C");
      assert.equal(await note.isVisible(), true, `${scene}: selecting Other reveals the explanation`);
      for (const width of [900, 400, 240]) {
        await page.setViewportSize({ width, height: 900 });
        const box = await note.boundingBox();
        assert.ok(box && box.width >= 40 && box.x + box.width <= width,
          `${scene}/${width}: the revealed input must fit the available width`);
      }
      await note.fill("  保存_under_score🙂  ");
      await choice.selectOption("A");
      assert.equal(await note.isVisible(), false, `${scene}: another option hides the explanation`);
      assert.equal(await note.inputValue(), "  保存_under_score🙂  ");
      await choice.evaluate(control => { control.disabled = true; });
      await page.waitForFunction(() => document.querySelector('input[data-note="fd_note"]')?.getClientRects().length > 0);
      assert.equal(await note.isVisible(), true, `${scene}: a disabled select keeps the explanation visible`);
      await choice.evaluate(control => { control.disabled = false; });
      await page.waitForFunction(() => !document.querySelector('input[data-note="fd_note"]')?.getClientRects().length);
      await note.evaluate(input => { input.readOnly = true; });
      assert.equal(await note.isVisible(), true, `${scene}: a read-only explanation remains visible`);
      await note.evaluate(input => { input.readOnly = false; });
      assert.equal(await note.isVisible(), false);
      await page.evaluate(() => {
        const note = document.querySelector('input[data-note="fd_note"]');
        const marker = document.createElement("div"); marker.className = "ele-xform-fieldset-required";
        note.closest(".ele-xform-fieldset").appendChild(marker);
      });
      assert.equal(await note.isVisible(), true, `${scene}: a dynamically required note remains reachable`);
      await page.evaluate(() => document.querySelector('input[data-note="fd_note"]')
        .closest(".ele-xform-fieldset").querySelector(".ele-xform-fieldset-required")?.remove());
      assert.equal(await note.isVisible(), false);
      await choice.selectOption("C");
      assert.equal(await note.isVisible(), true);
      assert.equal(await note.inputValue(), "  保存_under_score🙂  ");
      await page.evaluate(() => {
        const select = document.querySelector('select[data-choice="fd_payment"]');
        const native = document.createElement("input"); native.setAttribute("role", "combobox");
        select.replaceWith(native); window.__setChoice("A");
      });
      assert.equal(await note.isVisible(), false, `${scene}: native combobox roles are supported`);
      await page.evaluate(() => window.__setChoice("C"));
      assert.equal(await note.isVisible(), true);
    }
  } finally {
    await browser.close();
  }
});
