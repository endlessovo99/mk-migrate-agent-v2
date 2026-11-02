import assert from 'node:assert/strict';import {it} from 'node:test';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
const fixture='tests/fixtures/route-validation/grouped-shared-row/route-grouped-row_SysFormTemplate.xml';
it('preserves edit, change and view behavior for shared source-bound row groups',()=>{
 const s=cleanSourceFile(fixture),d=draftSourceDraft(s),a=(d.scripts?.actions||[]).filter(x=>x.event==='onLoad'||x.event==='onChange');
 assert.equal(a.filter(x=>x.translationStatus==='needs_review').length,0);
 assert.equal(a.filter(x=>x.translationStatus==='mapped').length,3);
});

it('preserves group priority, hidden mirror, delayed initialization and view/edit row states',async()=>{
 const {runInNewContext}=await import('node:vm');const d=draftSourceDraft(cleanSourceFile(fixture));
 const actions=d.scripts.actions.filter(a=>a.translationStatus==='mapped');
 const edit=actions.find(a=>a.event==='onLoad'&&a.runWhen?.viewStatusIn?.includes('edit'));
 const change=actions.find(a=>a.event==='onChange'),view=actions.find(a=>a.event==='onLoad'&&a.runWhen?.viewStatusIn?.includes('view'));
 assert.ok(edit&&change&&view);
 const make=(mode)=>{let values={fd_mode:mode,fd_mirror:mode},rows={},timers=[];const MKXFORM={getValue:id=>values[id],setValue:(id,v)=>{values[id]=v},setFieldAttr:(id,n)=>{let state=rows[id] ||= {};if(n===4)state.visible=false;if(n===5)state.visible=true;if(n===3)state.required=true;if(n===6)state.required=false}};return {values,rows,timers,MKXFORM}};
 for(const mode of ['A','B','C','',undefined]){
  for(const [kind,a] of [['edit',edit],['view',view],['change',change]]){
   const h=make(mode),fn=runInNewContext('('+a.function+')',{MKXFORM:h.MKXFORM,setTimeout:(cb,ms)=>h.timers.push({cb,ms}),String,Array});
   fn(mode);if(kind==='edit'){assert.equal(h.timers[0].ms,510);h.timers[0].cb()}
   for(const [i,id] of ['fd_a_row','fd_b_row','fd_c_row'].entries()){
    assert.equal(h.rows[id]?.visible,mode===['A','B','C'][i],`${kind} ${mode} ${id}`);
    assert.equal(h.rows[id]?.required,kind!=='view'&&mode===['A','B','C'][i],`${kind} ${mode} ${id}`);
   }
   if(kind==='change')assert.equal(h.values.fd_mirror,mode===null?'':String(mode));
  }
 }
});

it('rejects changed source helpers, dynamic values or extra source effects',()=>{
 const original=cleanSourceFile(fixture);
 const mutations=[
  s=>s.scripts.sources[0].javascript=s.scripts.sources[0].javascript.replace('"fd_a_row",true,editFlag,false','"fd_a_row",true,editFlag,true'),
  s=>s.scripts.sources[1].javascript+='unknownSideEffect();',
  s=>s.scripts.sources[2].javascript=s.scripts.sources[2].javascript.replace('setEdit(false,','setEdit(true,'),
  s=>s.scripts.sources[0].javascript=s.scripts.sources[0].javascript.replace("['A']","['A', window.dynamic]"),
 ];
 for(const mutate of mutations){const s=structuredClone(original);mutate(s);assert.equal(draftSourceDraft(s).scripts.actions.some(a=>a.functionMappings?.some(m=>m.basis==='deterministic-grouped-shared-row')),false);}
});

it('carries the grouped lifecycle through trust, fake execution and persisted script readback',async()=>{
 const {runAgentReview}=await import('../../src/agent-review/index.js');const {checkTrust}=await import('../../src/dsl/trust.js');
 const {buildDryRunPlan}=await import('../../src/executor/dry-run.js');const {executeDsl}=await import('../../src/executor/execute.js');
 const {createFakeReviewProvider}=await import('./fake-review-provider.js');const {FakeNewoaAdapter}=await import('./fake-newoa-adapter.js');const {withNetworkGuard}=await import('./network-guard.js');
 await withNetworkGuard(async()=>{let s=cleanSourceFile(fixture),d=draftSourceDraft(s),review=await runAgentReview(s,d,{provider:createFakeReviewProvider('accept')});
  assert.equal(review.ok,true,JSON.stringify(review.diagnostics));assert.equal(checkTrust(s,review.dsl).ok,true);assert.equal(buildDryRunPlan(review.dsl).ok,true);
  const tampered=structuredClone(review.dsl),action=tampered.scripts.actions.find(a=>a.event==='onChange');action.function=action.function.replace('!== -1','=== -1');assert.equal(checkTrust(s,tampered).ok,false);
  const foreign=new FakeNewoaAdapter('persist');const denied=await executeDsl(review.dsl,{client:foreign,confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'test',encryptedPassword:'test'},baseUrl:'https://p-sit.onewo.com'});assert.equal(denied.ok,false);assert.ok(denied.diagnostics.some(x=>x.code==='safety.grouped_radio_origin_unverified'));assert.equal(foreign.entries.some(x=>x.operation==='login'),false);
  let client=new FakeNewoaAdapter('persist'),r=await executeDsl(review.dsl,{client,confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'test',encryptedPassword:'test'},baseUrl:'https://oaqas.shanghai-electric.com'});
  assert.equal(r.ok,true,JSON.stringify(r.diagnostics));assert.equal(r.readback.partitions.scripts,'verified');assert.equal(r.transferRecord.status,'recorded');
 });
});

it('rejects unknown runtime scripts, extra inline handlers and ambiguous hidden bindings',async()=>{
 const {mkdtempSync,readFileSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const xml=readFileSync(fixture,'utf8'),mutations=[
   s=>s.replace('&lt;/xform:radio&gt;','&lt;/xform:radio&gt;&lt;script src="/unknown.js"&gt;&lt;/script&gt;'),
   s=>s.replace('&lt;xform:radio property=', '&lt;xform:radio onclick="unknown()" property='),
   s=>s.replace('showStatus="noShow"','showStatus="view"'),
   s=>s.replace('&lt;xform:xtext property="extendDataFormInfo.value(fd_mirror)" showStatus="noShow"/&gt;', '&lt;xform:xtext property="extendDataFormInfo.value(fd_mirror)" showStatus="noShow"/&gt;&lt;xform:xtext property="extendDataFormInfo.value(fd_mirror)" showStatus="noShow"/&gt;')
 ];
 const dir=mkdtempSync(join(tmpdir(),'grouped-domain-'));try{for(const [i,mutate] of mutations.entries()){
  const changed=mutate(xml);assert.notEqual(changed,xml);const file=join(dir,`changed-${i}_SysFormTemplate.xml`);writeFileSync(file,changed);
  const draft=draftSourceDraft(cleanSourceFile(file));assert.equal(draft.scripts.actions.some(a=>a.functionMappings?.some(m=>m.basis==='deterministic-grouped-shared-row')),false,`mutation ${i}`);
 }}finally{rmSync(dir,{recursive:true,force:true})}
});

it('does not treat extra executable content inside an attachment import as inert',async()=>{
 const {readFileSync}=await import('node:fs');const {parseRootHashMapStringPuts}=await import('../../src/translator/xml-utils.js');
 const {groupedSharedSourceDomain}=await import('../../src/translator/grouped-shared-row.js');
 const template=parseRootHashMapStringPuts(readFileSync(fixture,'utf8')),source=cleanSourceFile(fixture);
 const attachment='<c:import url="/sys/attachment/sys_att_main/sysAttMain_${empty _xformRight ? ((_xformMainForm.method_GET == \'add\' || _xformMainForm.method_GET == \'edit\') ? \'edit\' : \'view\') : (_xformRight == \'edit\' ? \'edit\' : \'view\')}.jsp" charEncoding="UTF-8">'+
 '<c:param name="fdAttType" value="byte"/><c:param name="fdMulti" value="true"/><c:param name="fdShowMsg" value="true"/>'+
 '<c:param name="fdImgHtmlProperty"/><c:param name="fdKey" value="fd_file"/><c:param name="fdModelId" value="${_xformMainForm.fdId}"/>'+
 '<c:param name="fdModelName" value="${_xformMainForm.modelClass.name}"/><c:param name="formBeanName" value="_xformMainForm"/></c:import>';
 assert.ok(groupedSharedSourceDomain({...template,fdDisplayJsp:attachment+template.fdDisplayJsp},source.scripts));
 const unsafe=attachment.replace('</c:import>','<jsp:include page="/unknown.jsp"/></c:import>');
 assert.equal(groupedSharedSourceDomain({...template,fdDisplayJsp:unsafe+template.fdDisplayJsp},source.scripts),undefined);
});
