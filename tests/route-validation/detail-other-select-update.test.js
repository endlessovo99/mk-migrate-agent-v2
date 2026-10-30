import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";
import { prepareDetailOtherSelectConfig } from "../../src/executor/detail-other-select-update-plan.js";
import { detailOtherSelectAction } from "../../src/executor/persistence/detail-other-select-reveal.js";

const fixture = "tests/fixtures/route-validation/choice-other-select-detail/choice-other-select-detail_SysFormTemplate.xml";
const pairs = [{ tableId: "fd_rows", choiceId: "fd_choice", textId: "fd_other_text", optionValue: "O_CODE" }];
function setup() {
  const source = cleanSourceFile(fixture), config = xformConfig(prepareSample(draftSourceDraft(source)).update);
  return { source, config, pairs: structuredClone(pairs) };
}
function addAction(input, fn) {
  const attr = JSON.parse(input.config.attribute.formAttr);
  attr.controlAction.control["test"] = { onChange: [{ id: "unsafe", name: "onChange", function: fn }] };
  input.config.attribute.formAttr = JSON.stringify(attr);
}
it("plans a source-bound detail reveal without changing stored fields, rules or views", () => {
  const input = setup(), before = structuredClone(input.config), planned = prepareDetailOtherSelectConfig(input);
  assert.equal(planned.changed, true); assert.deepEqual(planned.config.dataModel, before.dataModel); assert.deepEqual(planned.config.viewModel, before.viewModel);
  const oldAttr = JSON.parse(before.attribute.formAttr), attr = JSON.parse(planned.config.attribute.formAttr);
  assert.deepEqual(attr.formRule, oldAttr.formRule); assert.deepEqual(attr.controlAction.control, oldAttr.controlAction.control);
  assert.ok(attr.controlAction.global.onLoad[0].migrationActions.some(action => action.id === "mk-choice-other-detail-select-v1"));
  assert.equal(prepareDetailOtherSelectConfig({ ...input, config: planned.config }).changed, false, "a repeated preview is idempotent");
});
it("does not widen the ordinary migration trust gate for unproven compound detail layouts", async () => {
  const result = await runRouteCase("select-other-option-detail-blocked-before-transport");
  assert.equal(result.review.stage, "agent-review.input"); assert.deepEqual(result.transcript, []);
});
it("accepts a bounded native visibility formula without treating it as executable source code", () => {
  const input = setup(), attr = JSON.parse(input.config.attribute.formAttr);
  const script = '(MKXFORM.viewStatus === "add" || MKXFORM.viewStatus === "edit") && (${data.biz.fd_choice} != null && ${data.biz.fd_choice}.indexOf("O_CODE") >= 0)';
  attr.formRule.display = [{ choices: { items: [{ condNodeType: "formula", value: { script, vo: { content: script }, varIds: ["fd_choice"] } }] }, result: [] }];
  input.config.attribute.formAttr = JSON.stringify(attr);
  assert.equal(prepareDetailOtherSelectConfig(input).changed, true);
});
it("rejects untrusted identifiers and duplicate runtime bindings", () => {
  for (const value of [[], [{ ...pairs[0], tableId: 'fd_rows"]{}' }], [pairs[0], pairs[0]]]) assert.throws(() => detailOtherSelectAction(value));
});
for (const [name, mutate] of [
  ["changed source pair", x => { x.source.form.detailTables[0].columns.find(f => f.id === "fd_choice").sourceProps.otherTextCompanion.id = "fd_note"; }],
  ["source text required", x => { x.source.form.detailTables[0].columns.find(f => f.id === "fd_other_text").required = true; }],
  ["changed native option", x => { const f = x.config.dataModel.find(m => m.fdTableName === "fd_rows").fdFields.find(v => v.fdName === "fd_choice"), a = JSON.parse(f.fdAttribute); a.config.controlProps.options.at(-1).value = "changed"; f.fdAttribute = JSON.stringify(a); }],
  ["native composite Other value", x => { const f = x.config.dataModel.find(m => m.fdTableName === "fd_rows").fdFields.find(v => v.fdName === "fd_choice"), a = JSON.parse(f.fdAttribute); a.config.controlProps.options.at(-1).type = "other"; f.fdAttribute = JSON.stringify(a); }],
  ["missing independent storage", x => { x.config.dataModel.find(m => m.fdTableName === "fd_rows").fdFields.find(v => v.fdName === "fd_other_text").fdIsStored = false; }],
  ["required target permission", x => { x.config.auth[0].add.fd_rows.fields.fd_other_text.required = true; }],
  ["native detail required rule", x => { const a = JSON.parse(x.config.attribute.formAttr); a.formRule.require = [{ result: [{ type: "fd_rows", fieldName: "fd_other_text", required: "required" }] }]; x.config.attribute.formAttr = JSON.stringify(a); }],
  ["dynamic source script access", x => { x.source.scripts = { fragments: [{ content: 'SetXFormFieldValueById("fd_other_text","x")' }] }; }],
  ["DOM mutation", x => addAction(x, 'function onChange(){document.body.hidden=true;}')],
  ["whole model replacement", x => addAction(x, `function onChange(){MKXFORM.setValue("${x.config.dataModel[0].fdTableName}",{});}`)],
  ["whole row required", x => addAction(x, 'function onChange(){MKXFORM.setDetailFieldItemAttr("fd_rows",3,0);} ')],
  ["dynamic native target", x => addAction(x, 'function onChange(id){MKXFORM.updateControl(id,0,"x");}')],
  ["unproved object callback", x => addAction(x, 'function onChange(){external.indexOf("x");}')],
  ["implicit global disguised by a nested declaration", x => addAction(x, 'function onChange(){function nested(){var escaped=0;}escaped=1;}')],
  ["unproved rule function", x => { const a = JSON.parse(x.config.attribute.formAttr); a.formRule.display = [{ choices: { items: [{ condNodeType: "formula", value: { script: 'external() && ${data.biz.fd_choice}', varIds: ["fd_choice"] } }] } }]; x.config.attribute.formAttr = JSON.stringify(a); }],
  ["formula with a hidden write", x => { const a = JSON.parse(x.config.attribute.formAttr); a.formRule.compute = [{ script: 'MKXFORM.setValue("fd_other_text","x")' }]; x.config.attribute.formAttr = JSON.stringify(a); }]
]) it(`fails closed for ${name}`, () => { const input = setup(); mutate(input); assert.throws(() => prepareDetailOtherSelectConfig(input)); });

it("tests desktop and mobile rows, required and readonly states without dropping values", { skip: process.env.MK_LAYOUT_BROWSER_TESTS !== "1" }, async () => {
  const { chromium } = await import(process.env.MK_LAYOUT_PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.MK_LAYOUT_BROWSER_PATH });
  try {
    const page = await browser.newPage(); await page.route("**/*", route => route.abort());
    const desktop = key => `<tr><td><div data-name="fd_rows.fd_choice~${key}"><div class="lui-select"></div></div></td><td id="d-${key}"><div><div data-name="fd_rows.fd_other_text~${key}"><input value="${key}-saved"></div></div></td></tr>`;
    const mobile = key => `<div data-id="fd_rows.fd_choice~${key}"><div class="mui-select"></div></div><div id="m-${key}" data-id="fd_rows.fd_other_text~${key}"><input value="${key}-saved"></div>`;
    await page.setContent(`<div id="fd_rows"><table><tbody>${desktop("a")}${desktop("b")}</tbody></table>${mobile("a")}${mobile("b")}</div>`);
    const action = detailOtherSelectAction(pairs);
    await page.evaluate(code => {
      const rows = [{ key: "a", fd_choice: "O_CODE", fd_other_text: "a-saved" }, { key: "b", fd_choice: "A", fd_other_text: "b-saved" }], listeners = [];
      window.__fixture = { rows, listeners, rules: [{ required: false }], calls: [] };
      window.MKXFORM = { MKXFORM_DATA_CONTAINER: {}, $$FORM: { current: {} }, viewStatus: "add", getValue: () => ({ values: rows }),
        $: () => ({ getSelf: () => ({ props: { columns: [{ controlProps: { name: "fd_other_text" }, options: { validateRules: window.__fixture.rules } }] } }) }),
        onChange: (_id, fn) => listeners.push(fn), setValue: (...args) => window.__fixture.calls.push(args) };
      (0, eval)(`(${code})`)({});
    }, action.function);
    const visible = async () => page.evaluate(() => ({ desktop: ["a", "b"].map(k => !!document.querySelector(`#d-${k} input`).getClientRects().length),
      mobile: ["a", "b"].map(k => !!document.querySelector(`#m-${k}`).getClientRects().length) }));
    assert.deepEqual(await visible(), { desktop: [true, false], mobile: [true, false] });
    await page.evaluate(() => { window.__fixture.rows[0].fd_choice = "A"; window.__fixture.listeners.forEach(fn => fn()); });
    await page.waitForFunction(() => !document.querySelector("#d-a input").getClientRects().length && !document.querySelector("#m-a").getClientRects().length);
    assert.deepEqual(await visible(), { desktop: [false, false], mobile: [false, false] });
    assert.deepEqual(await page.evaluate(() => window.__fixture.rows.map(row => row.fd_other_text)), ["a-saved", "b-saved"]);
    await page.evaluate(() => { const star = document.createElement("div"); star.textContent = "*"; star.style.color = "rgb(255, 68, 68)"; document.querySelector("#d-b > div").prepend(star); const m = document.createElement("span"); m.className = "ele-xform-fieldset-label-required"; document.querySelector("#m-b").prepend(m); });
    await page.waitForFunction(() => document.querySelector("#d-b input").getClientRects().length && document.querySelector("#m-b").getClientRects().length);
    assert.deepEqual(await visible(), { desktop: [false, true], mobile: [false, true] });
    await page.evaluate(() => { document.querySelector("#d-b > div > div[style]").remove(); document.querySelector("#m-b .ele-xform-fieldset-label-required").remove(); document.querySelector("#m-b input").readOnly = true; document.querySelector("#d-b input").readOnly = true; });
    await page.waitForFunction(() => document.querySelector("#d-b input").getClientRects().length && document.querySelector("#m-b").getClientRects().length);
    assert.deepEqual(await visible(), { desktop: [false, true], mobile: [false, true] });
    assert.deepEqual(await page.evaluate(() => window.__fixture.calls), []);
  } finally { await browser.close(); }
});
