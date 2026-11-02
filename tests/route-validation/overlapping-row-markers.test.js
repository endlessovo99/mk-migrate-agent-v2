import assert from 'node:assert/strict';import {it} from 'node:test';import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';import {buildFormRuleRefIndex,resolveEffectTarget} from '../../src/dsl/form-rules.js';import {buildSetFieldAttrTargetIndex,compileSetFieldAttrRowMarkerTargets} from '../../src/dsl/scripts.js';
const fixture='tests/fixtures/route-validation/overlapping-row-markers/route-overlapping-row_SysFormTemplate.xml';
it('keeps a shared marker over every physical row rather than narrowing it to one overlapping group',()=>{
 const s=cleanSourceFile(fixture),d=draftSourceDraft(s),index=buildFormRuleRefIndex(d.form);
 assert.deepEqual(resolveEffectTarget(index,'fd_alias_row').targets.map(x=>x.id).sort(),['fd_extra','fd_value']);
 assert.equal(buildSetFieldAttrTargetIndex(d.form).secondaryMarkerToPrimary.has('fd_alias_row'),false);
 const action=d.scripts.actions.find(a=>a.event==='onChange');assert.equal(action.translationStatus,'mapped');
 assert.match(action.function,/setFieldAttr\("fd_alias_row"/);
 const compiled=compileSetFieldAttrRowMarkerTargets(action.function,d.form);
 assert.match(compiled,/setFieldAttr\("fd_extra"/);assert.match(compiled,/setFieldAttr\("fd_value"/);
});

it('preserves the complete physical row set through fake execution and readback',async()=>{
 const {runAgentReview}=await import('../../src/agent-review/index.js');const {checkTrust}=await import('../../src/dsl/trust.js');const {executeDsl}=await import('../../src/executor/execute.js');
 const {createFakeReviewProvider}=await import('./fake-review-provider.js');const {FakeNewoaAdapter}=await import('./fake-newoa-adapter.js');const {withNetworkGuard}=await import('./network-guard.js');
 await withNetworkGuard(async()=>{let source=cleanSourceFile(fixture),draft=draftSourceDraft(source),r=await runAgentReview(source,draft,{provider:createFakeReviewProvider('accept')});assert.equal(r.ok,true,JSON.stringify(r.diagnostics));assert.equal(checkTrust(source,r.dsl).ok,true);
  let result=await executeDsl(r.dsl,{client:new FakeNewoaAdapter('persist'),confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'test',encryptedPassword:'test'},baseUrl:'https://p-sit.onewo.com'});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));assert.equal(result.readback.partitions.scripts,'verified');assert.equal(result.transferRecord.status,'recorded');
 });
});

it('does not invent a target for a multi-group marker that is never a primary marker',async()=>{
 const {readFileSync,mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 let xml=readFileSync(fixture,'utf8'),needle='&lt;input type="hidden" id="fd_alias_row" name="fd_alias_row"/&gt;&lt;div fd_type="inputText" fd_values=\'{id:"fd_extra"';
 let changed=xml.replace(needle,'&lt;input type="hidden" id="fd_other_row" name="fd_other_row"/&gt;'+needle).replace('&lt;/script&gt;', 'Com_AddEventListener(window,"load",function(){common_dom_row_set_show_required_reset("fd_other_row",true,false,false)});&lt;/script&gt;');assert.notEqual(changed,xml);
 let dir=mkdtempSync(join(tmpdir(),'row-overlap-'));try{let file=join(dir,'changed_SysFormTemplate.xml');writeFileSync(file,changed);let d=draftSourceDraft(cleanSourceFile(file));
  assert.equal(buildSetFieldAttrTargetIndex(d.form).persistedRowTargets.has('fd_alias_row'),false);
  assert.equal(buildSetFieldAttrTargetIndex(d.form).secondaryMarkerToPrimary.has('fd_alias_row'),false);
  assert.notEqual(d.scripts.actions.find(a=>a.event==='onChange')?.translationStatus,'mapped');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
