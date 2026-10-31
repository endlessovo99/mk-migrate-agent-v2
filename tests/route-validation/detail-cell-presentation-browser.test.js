import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { adaptiveStyles } from "../../src/executor/persistence/adaptive-layout.js";
import { withDetailCellPresentation } from "../../src/executor/persistence/detail-cell-presentation.js";

const fixture = "tests/fixtures/route-validation/detail-shared-source-cell/shared-source-cell_SysFormTemplate.xml";

it("keeps generated detail-cell presentation scoped and reversible in a real browser", {
  skip: process.env.MK_DETAIL_CELL_BROWSER_TESTS !== "1"
}, async () => {
  const playwright = await import(process.env.MK_LAYOUT_PLAYWRIGHT_MODULE || "playwright-core");
  for (const engine of (process.env.MK_DETAIL_CELL_BROWSERS || "chromium").split(",")) {
    assert.ok(["chromium", "webkit"].includes(engine));
    const browser = await playwright[engine].launch({ headless: true,
      ...(engine === "chromium" && process.env.MK_LAYOUT_BROWSER_PATH ? { executablePath: process.env.MK_LAYOUT_BROWSER_PATH } : {}) });
    try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.route("**/*", route => route.abort());
    const form = draftSourceDraft(cleanSourceFile(fixture)).form, main = "mk_model_test";
    const scope = adaptiveStyles(main).scope, actions = withDetailCellPresentation({ actions: [] }, form, main).actions;
    const action = actions[1].function, formAction = actions[0].function;
    assert.equal(actions[1].id, "mk-detail-cell-presentation-v1.fd_rows");
    const base = `<style>
      table{border-collapse:collapse}th,td{border:1px solid rgb(100,100,100);min-width:100px;height:38px}
      .hidden,[data-mk-detail-other=closed]{display:none!important}.ele-xform-fieldset-wrap{display:block;min-height:35px}
      .ele-xform-fieldset-wrap::after{content:'';display:block;height:1px;background:#aaa}
      .ele-xform-fieldset-label-wrap{min-height:20px}.ele-xform-fieldset-label-required{color:red}
    </style>`;
    const setup = `<script>
      window.__columns=[{key:'fd_rows.fd_choice',label:'设备类别',type:'@elem/xform-select',controlProps:{name:'fd_choice'}},
        {key:'fd_rows.fd_other_text',label:'设备类别',type:'@elem/xform-input',controlProps:{name:'fd_other_text'}},
        {key:'fd_rows.fd_note',label:'Note',type:'@elem/xform-input',controlProps:{name:'fd_note'}}];
      window.__props={columns:window.__columns,extraAuth:{},authFields:{fields:{}}};
      window.MKXFORM={MKXFORM_DATA_CONTAINER:{},$$FORM:{current:{}},$:()=>({getSelf:()=>({props:window.__props})})};
    </script>`;
    const prefix = `${base}<div class="ele-xform-appearance"><div class="${scope}"></div><main id="main"><div data-id="fd_rows">`;
    const suffix = `</div></main></div>${setup}`;
    const desktop = `${prefix}<div class="ele-xform-detail-table-table"><table><thead><tr>
      <th class="lui-table-selection-column"></th><th class="lui-pro-table-cell-serial"><span title="序号">序号</span></th>
      <th><span><i class="required">*</i><span title="设备类别">设备类别</span></span></th>
      <th><span><i class="required">*</i><span title="设备类别">设备类别</span></span></th>
      <th><span><span title="Note">Note</span></span></th><th class="lui-pro-table-cell-operations">操作</th>
      </tr></thead><tbody><tr><td></td><td>1</td>
      <td><div data-name="fd_rows.fd_choice~row-a"><input value="A"></div></td>
      <td><div data-name="fd_rows.fd_other_text~row-a"><input value="B"></div></td>
      <td><div data-name="fd_rows.fd_note~row-a"><input value="C"></div></td><td></td>
      </tr></tbody></table></div>${suffix}`;
    await page.setContent(desktop);
    await page.evaluate(source => Function(`return (${source})`)()({}), action);
    await page.waitForFunction(() => document.querySelectorAll("th[data-mk-detail-cell]").length === 2);
    const initialState = await page.evaluate(() => MKXFORM.MKXFORM_DATA_CONTAINER.__mkDetailCellPresentationV1.styleId);
    assert.equal(await page.evaluate(source => { const before = MKXFORM.MKXFORM_DATA_CONTAINER.__mkDetailCellPresentationV1;
      Function(`return (${source})`)()({}); return before === MKXFORM.MKXFORM_DATA_CONTAINER.__mkDetailCellPresentationV1; }, formAction), true);
    let result = await page.evaluate(() => {
      const th = document.querySelector('th[data-mk-detail-cell$="-end"]'), title = th.querySelector("span[title]"), star = th.querySelector("i.required");
      const cell = document.querySelector('[data-name^="fd_rows.fd_choice~"]').closest("td");
      return { clip: getComputedStyle(title).clipPath, star: !!star.getClientRects().length,
        border: getComputedStyle(cell).borderRightColor, values: [...document.querySelectorAll("tbody input")].map(input => input.value) };
    });
    assert.deepEqual(result, { clip: "inset(50%)", star: true, border: "rgba(0, 0, 0, 0)", values: ["A", "B", "C"] });
    assert.match(await page.locator('th[data-mk-detail-cell$="-end"]').ariaSnapshot(), /设备类别/);
    await page.evaluate(() => { const row = document.querySelector("tbody tr").cloneNode(true);
      row.querySelector('[data-name^="fd_rows.fd_choice~"]').setAttribute("data-name", "fd_rows.fd_choice~row-b");
      row.querySelector('[data-name^="fd_rows.fd_other_text~"]').setAttribute("data-name", "fd_rows.fd_other_text~row-c");
      row.querySelectorAll('[data-mk-detail-cell]').forEach(node => node.removeAttribute("data-mk-detail-cell"));
      document.querySelector("tbody").appendChild(row); });
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 2);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('tbody tr').nth(1).locator('td').nth(2).evaluate(node => getComputedStyle(node).borderRightColor), "rgb(100, 100, 100)");
    await page.evaluate(() => { document.querySelector("tbody").innerHTML = ""; });
    await page.waitForFunction(() => document.querySelectorAll("th[data-mk-detail-cell]").length === 2);
    assert.equal(await page.locator('th[data-mk-detail-cell$="-end"] span[title]').evaluate(node => getComputedStyle(node).clipPath), "inset(50%)");
    await page.evaluate(() => { document.querySelectorAll("thead th")[2].remove(); });
    await page.waitForFunction(() => document.querySelectorAll("th[data-mk-detail-cell]").length === 0);
    assert.equal(await page.locator('thead th span[title="设备类别"]').evaluate(node => getComputedStyle(node).clipPath), "none");

    const mobile = `${prefix}<div class="ele-xform-m-detail-table"><div class="ele-xform-m-detail-table-content-simple"><div class="row"><div class="content">
      <div class="ele-xform-fieldset-wrap" data-id="fd_rows.fd_choice~row-a"><div class="ele-xform-fieldset-label-wrap"><span class="ele-xform-fieldset-label-title-align">设备类别</span></div><input value="A"></div>
      <div class="hidden"></div>
      <div class="ele-xform-fieldset-wrap" data-id="fd_rows.fd_other_text~row-a"><div class="ele-xform-fieldset-label-wrap"><span class="ele-xform-fieldset-label-required">*</span><span class="ele-xform-fieldset-label-title-align">设备类别</span></div><input value="B"></div>
      </div></div></div></div>${suffix}`;
    await page.setContent(mobile);
    await page.evaluate(source => Function(`return (${source})`)()({}), action);
    await page.waitForFunction(() => document.querySelectorAll('.ele-xform-m-detail-table [data-mk-detail-cell]').length === 2);
    result = await page.evaluate(() => {
      const a = document.querySelector('[data-id^="fd_rows.fd_choice~"]'), b = document.querySelector('[data-id^="fd_rows.fd_other_text~"]');
      return { clip: getComputedStyle(b.querySelector('.ele-xform-fieldset-label-title-align')).clipPath,
        star: !!b.querySelector('.ele-xform-fieldset-label-required').getClientRects().length,
        separator: getComputedStyle(a, '::after').content, values: [a.querySelector('input').value, b.querySelector('input').value] };
    });
    assert.deepEqual(result, { clip: "inset(50%)", star: true, separator: "none", values: ["A", "B"] });
    assert.match(await page.locator('[data-id^="fd_rows.fd_other_text~"]').ariaSnapshot(), /设备类别/);
    for (const width of [320, 390, 550]) {
      await page.setViewportSize({ width, height: 844 });
      const bounds = await page.locator('[data-id^="fd_rows.fd_other_text~"] input').boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, `${engine}/${width}: ${JSON.stringify(bounds)}`);
      assert.equal(await page.locator('[data-id^="fd_rows.fd_other_text~"] .ele-xform-fieldset-label-title-align')
        .evaluate(node => getComputedStyle(node).clipPath), "inset(50%)");
    }
    await page.evaluate(() => { document.querySelector('[data-id^="fd_rows.fd_choice~"]').style.display = "none"; });
    await page.waitForFunction(() => document.querySelectorAll('.ele-xform-m-detail-table [data-mk-detail-cell]').length === 0);
    assert.equal(await page.locator('[data-id^="fd_rows.fd_other_text~"] .ele-xform-fieldset-label-title-align')
      .evaluate(node => getComputedStyle(node).clipPath), "none");
    await page.evaluate(() => { document.querySelector('[data-id^="fd_rows.fd_choice~"]').style.display = ""; });
    await page.waitForFunction(() => document.querySelectorAll('.ele-xform-m-detail-table [data-mk-detail-cell]').length === 2);
    await page.evaluate(() => { document.querySelector('[data-id^="fd_rows.fd_other_text~"]').setAttribute('data-mk-detail-other', 'closed'); });
    await page.waitForFunction(() => document.querySelectorAll('.ele-xform-m-detail-table [data-mk-detail-cell]').length === 0);
    await page.evaluate(() => { document.querySelector('[data-id^="fd_rows.fd_other_text~"]').setAttribute('data-mk-detail-other', 'open'); });
    await page.waitForFunction(() => document.querySelectorAll('.ele-xform-m-detail-table [data-mk-detail-cell]').length === 2);
    await page.evaluate(() => { document.querySelector('[data-id^="fd_rows.fd_other_text~"] input').readOnly = true; });
    assert.equal(await page.locator('[data-id^="fd_rows.fd_other_text~"] input').evaluate(node => node.readOnly), true);
    assert.equal(await page.locator('.ele-xform-m-detail-table [data-mk-detail-cell]').count(), 2);
    await page.evaluate(() => { const root = document.querySelector('[data-id="fd_rows"]'); root.after(root.cloneNode(true)); });
    await page.waitForFunction(() => document.querySelectorAll('.ele-xform-m-detail-table [data-mk-detail-cell]').length === 0);
    await page.evaluate(() => { document.querySelectorAll('[data-id="fd_rows"]')[1].remove(); });
    await page.waitForFunction(() => document.querySelectorAll('.ele-xform-m-detail-table [data-mk-detail-cell]').length === 2);
    await page.evaluate(() => { MKXFORM.$$FORM.current = {}; document.querySelector('[data-id="fd_rows"]').className = "changed"; });
    await page.waitForFunction(() => !MKXFORM.MKXFORM_DATA_CONTAINER.__mkDetailCellPresentationV1);
    assert.equal(await page.locator('.ele-xform-m-detail-table [data-mk-detail-cell]').count(), 0);
    await page.setContent(desktop);
    await page.evaluate(id => { const style = document.createElement("style"); style.id = id; style.textContent = "/* foreign style */"; document.head.appendChild(style); }, initialState);
    await page.evaluate(source => Function(`return (${source})`)()({}), action);
    assert.equal(await page.locator('[data-mk-detail-cell]').count(), 0);
    assert.equal(await page.evaluate(() => !!MKXFORM.MKXFORM_DATA_CONTAINER.__mkDetailCellPresentationV1), false);
    await page.evaluate(id => document.getElementById(id).remove(), initialState);
    assert.equal(await page.evaluate(source => { const original = CSS.supports; CSS.supports = undefined;
      try { Function(`return (${source})`)()({}); const state = MKXFORM.MKXFORM_DATA_CONTAINER.__mkDetailCellPresentationV1;
        const installed = !!state; state?.dispose(); return installed; } finally { CSS.supports = original; } }, action), true);
    assert.equal(await page.evaluate(source => { const original = window.MutationObserver; window.MutationObserver = undefined;
      try { Function(`return (${source})`)()({}); return !!MKXFORM.MKXFORM_DATA_CONTAINER.__mkDetailCellPresentationV1; }
      finally { window.MutationObserver = original; } }, action), false);
    } finally { await browser.close(); }
  }
});
