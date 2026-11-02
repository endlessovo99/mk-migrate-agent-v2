import assert from 'node:assert/strict';
import {it} from 'node:test';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {checkDraft,checkExecute} from '../../src/dsl/checks.js';
import {checkTrust,createTrustedMigrationDsl} from '../../src/dsl/trust.js';
import {withDetailCellPresentation} from '../../src/executor/persistence/detail-cell-presentation.js';
import {executeDsl} from '../../src/executor/execute.js';
import {DETAIL_CELL_PRESENTATION_CAPABILITY} from '../../src/dsl/detail-cell-presentation-capability.js';
import {FakeNewoaAdapter} from './fake-newoa-adapter.js';
import {readFileSync} from 'node:fs';
import {parseRootHashMapStringPuts} from '../../src/translator/xml-utils.js';
import {translateSysFormTemplateXml} from '../../src/translator/sysform-template-adapter.js';
import {sourceDraftFromLegacyDsl} from '../../src/translator/source-draft.js';

for (const kind of ['number','calculate']) it(`preserves a narrow readonly ${kind} in a source-proven shared detail cell`,()=>{
 const source=cleanSourceFile(`tests/fixtures/route-validation/detail-narrow-numeric/${kind}_SysFormTemplate.xml`),draft=draftSourceDraft(source);
 const table=draft.form.fields.find(x=>x.id==='fd_rows'),narrow=table.columns.find(x=>x.id==='fd_other_text');
 assert.equal(narrow.componentId,kind==='calculate'?'xform-calculate':'xform-number');assert.equal(narrow.props.readOnly,true);
 assert.equal(checkDraft(draft).diagnostics.some(x=>x.code==='source.form.detail_cell_layout_unproven'),false);
 assert.deepEqual(table.detailCellGroups[0].fieldIds,['fd_choice','fd_other_text']);assert.equal(table.detailCellGroups[0].secondWidthPx,1);
 const trusted=createTrustedMigrationDsl(source,draft,{externalAgentReviewed:true});assert.equal(checkTrust(source,trusted).ok,true);assert.equal(checkExecute(trusted).ok,true);
 const actions=withDetailCellPresentation({actions:[]},trusted.form,'mk_model_test').actions;
 assert.match(actions[0].function,/body-end/);assert.match(actions[0].function,/width:1px!important/);
});

it('requires the runtime field to have the same unambiguous one-pixel width',()=>{
 const properties=parseRootHashMapStringPuts(readFileSync('tests/fixtures/route-validation/detail-narrow-numeric/number_SysFormTemplate.xml','utf8'));
 const encode=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 for(const replacement of ['WIDTH: 2px','WIDTH: 1px; width: 2px','WIDTH: calc(1px)']){
  const changed={...properties,fdDisplayJsp:properties.fdDisplayJsp.replace('WIDTH: 1px',replacement)};
  const xml='<java><object class="java.util.HashMap">'+Object.entries(changed).map(([k,v])=>`<void method="put"><string>${encode(k)}</string><string>${encode(v)}</string></void>`).join('')+'</object></java>';
  const draft=draftSourceDraft(sourceDraftFromLegacyDsl(translateSysFormTemplateXml(xml)));
  assert.ok(checkDraft(draft).diagnostics.some(x=>x.code==='source.form.detail_cell_layout_unproven'));
 }
});

it('fails closed for altered widths, editability, or a forged group',()=>{
 const source=cleanSourceFile('tests/fixtures/route-validation/detail-narrow-numeric/number_SysFormTemplate.xml');
 for(const change of [
   s=>{s.form.detailTables[0].columns[1].sourceProps.designerValues.width='2';},
   s=>{s.form.detailTables[0].columns[1].sourceProps.designerValues.readOnly='false';}
 ]) {
  const changed=structuredClone(source);change(changed);const draft=draftSourceDraft(changed);
  assert.ok(checkDraft(draft).diagnostics.some(x=>x.code==='source.form.detail_cell_layout_unproven'));
 }
 const draft=draftSourceDraft(source), forged=structuredClone(draft);
 forged.form.fields.find(x=>x.id==='fd_rows').detailCellGroups[0].secondWidthPx=2;
 assert.equal(checkTrust(source,createTrustedMigrationDsl(source,forged,{externalAgentReviewed:true})).ok,false);
 assert.equal(checkExecute(createTrustedMigrationDsl(source,forged,{externalAgentReviewed:true})).ok,false);
});

for(const kind of ['number','calculate']) it(`round-trips the ${kind} group through the fake QAS executor`,async()=>{
 const source=cleanSourceFile(`tests/fixtures/route-validation/detail-narrow-numeric/${kind}_SysFormTemplate.xml`);
 const dsl=createTrustedMigrationDsl(source,draftSourceDraft(source),{externalAgentReviewed:true});
 const client=new FakeNewoaAdapter('persist',{detailCellRuntime:true,templateAuthorization:dsl.template?.authorization});
 const result=await executeDsl(dsl,{client,baseUrl:DETAIL_CELL_PRESENTATION_CAPABILITY.origin,
  credentials:{username:'fixture',encryptedPassword:'fixture'},confirmWrite:true,targetCategoryId:'route-category-id'});
 assert.equal(result.ok,true,JSON.stringify({status:result.status,stage:result.stage,diagnostics:result.diagnostics}));
 assert.equal(result.readback.partitions.scripts,'verified');
});

it('keeps a narrow field mounted and one pixel wide on both native detail layouts',{
 skip:process.env.MK_DETAIL_CELL_BROWSER_TESTS!=='1'
},async()=>{
 const {chromium}=await import(process.env.MK_LAYOUT_PLAYWRIGHT_MODULE||'playwright-core');
 const {adaptiveStyles}=await import('../../src/executor/persistence/adaptive-layout.js');
 const browser=await chromium.launch({headless:true,executablePath:process.env.MK_LAYOUT_BROWSER_PATH});
 try{
  const page=await browser.newPage(),source=cleanSourceFile('tests/fixtures/route-validation/detail-narrow-numeric/number_SysFormTemplate.xml');
  const form=draftSourceDraft(source).form,scope=adaptiveStyles('mk_model_test').scope;
  const action=withDetailCellPresentation({actions:[]},form,'mk_model_test').actions[0].function;
  const setup=`<script>window.__props={columns:[{label:'设备类别',type:'@elem/xform-select',controlProps:{name:'fd_choice'}},{label:'设备类别',type:'@elem/xform-number',controlProps:{name:'fd_other_text'}},{label:'Note',type:'@elem/xform-input',controlProps:{name:'fd_note'}}],extraAuth:{},authFields:{fields:{}}};window.MKXFORM={MKXFORM_DATA_CONTAINER:{},$$FORM:{current:{}},$:()=>({getSelf:()=>({props:window.__props})})};</script>`;
  const wrap=body=>`<style>table{table-layout:fixed;border-collapse:collapse;width:300px}th,td{min-width:0;padding:0;border:0}.ele-xform-fieldset-wrap{display:block}</style><div class="${scope}"></div><main><div data-id="fd_rows">${body}</div></main>${setup}`;
  await page.setContent(wrap(`<div class="ele-xform-detail-table-table"><table><thead><tr><th><span><span title="设备类别">设备类别</span></span></th><th><span><span title="设备类别">设备类别</span></span></th><th><span><span title="Note">Note</span></span></th></tr></thead><tbody><tr><td><div data-name="fd_rows.fd_choice~r"><input value="A"></div></td><td><div data-name="fd_rows.fd_other_text~r"><input value="0"></div></td><td><div data-name="fd_rows.fd_note~r"></div></td></tr></tbody></table></div>`));
  await page.evaluate(s=>Function(`return (${s})`)()({}),action);
  await page.waitForFunction(()=>document.querySelector('td[data-mk-detail-cell$="-body-end"]'));
  assert.equal(await page.locator('td[data-mk-detail-cell$="-body-end"]').evaluate(n=>getComputedStyle(n).width),'1px');
  assert.equal(await page.locator('[data-name^="fd_rows.fd_other_text~"] input').inputValue(),'0');
  await page.setContent(wrap(`<div class="ele-xform-m-detail-table"><div class="ele-xform-m-detail-table-content-simple"><div class="row"><div class="content"><div class="ele-xform-fieldset-wrap" data-id="fd_rows.fd_choice~r"><div class="ele-xform-fieldset-label-wrap"><span class="ele-xform-fieldset-label-title-align">设备类别</span></div><input value="A"></div><div class="ele-xform-fieldset-wrap" data-id="fd_rows.fd_other_text~r"><div class="ele-xform-fieldset-label-wrap"><span class="ele-xform-fieldset-label-title-align">设备类别</span></div><input value="0"></div></div></div></div></div>`));
  await page.evaluate(s=>Function(`return (${s})`)()({}),action);
  await page.waitForFunction(()=>document.querySelector('[data-mk-detail-cell$="-end-optional"]'));
  assert.equal(await page.locator('[data-mk-detail-cell$="-end-optional"]').evaluate(n=>getComputedStyle(n).width),'1px');
  assert.equal(await page.locator('[data-id^="fd_rows.fd_other_text~"] input').inputValue(),'0');
 }finally{await browser.close();}
});
