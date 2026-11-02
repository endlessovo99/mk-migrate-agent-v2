import assert from 'node:assert/strict';
import {it} from 'node:test';
import {createHash} from 'node:crypto';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {attachMigrationPolicies,migrationPolicySourceDigest} from '../../src/translator/approved-migration-policies.js';
import {runAgentReview} from '../../src/agent-review/index.js';
import {checkTrust} from '../../src/dsl/trust.js';
import {executeDsl} from '../../src/executor/execute.js';
import {createFakeReviewProvider} from './fake-review-provider.js';
import {FakeNewoaAdapter} from './fake-newoa-adapter.js';
import {withNetworkGuard} from './network-guard.js';

const scope={baseUrl:'https://oaqas.shanghai-electric.com',targetCategoryId:'route-category-id'};
const sha=s=>'sha256:'+createHash('sha256').update(s).digest('hex');
it('translates a source-proven dynamic invoice link to a scoped button through trust and fake execution',async()=>withNetworkGuard(async()=>{
 const source=cleanSourceFile('tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml');
 const before=draftSourceDraft(source), original=before.scripts.actions.find(a=>a.functionMappings?.some(m=>m.basis==='deterministic-dynamic-hyperlink'));
 const sourceScript=source.scripts.sources.find(s=>s.sourceRef===original.sourceRefs[0]);
 const decision={kind:'native-dynamic-link-button',sourceRef:sourceScript.sourceRef,sourceJavascriptSha256:sha(sourceScript.javascript),actionId:original.id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'};
 const policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fictional fixture authorization')},decisions:[decision]};
 const approved=attachMigrationPolicies(source,policy,scope),draft=draftSourceDraft(approved);
 const field=draft.form.fields.find(f=>f.id==='invoiceLink');assert.equal(field.componentId,'xform-button');
 const click=draft.scripts.actions.find(a=>a.event==='onClick'&&a.controlId==='invoiceLink');assert.ok(click);
 const reviewed=await runAgentReview(approved,draft,{provider:createFakeReviewProvider('accept')});assert.equal(reviewed.ok,true,JSON.stringify(reviewed.report?.diagnostics));assert.equal(checkTrust(approved,reviewed.dsl).ok,true);
 const blockedClient=new FakeNewoaAdapter('persist');blockedClient.baseUrl=scope.baseUrl;const blocked=await executeDsl(reviewed.dsl,{...scope,client:blockedClient,confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}});assert.equal(blocked.ok,false);assert.equal(blockedClient.transcript().some(item=>item.operation==='add'),false);
 const client=new FakeNewoaAdapter('persist',{detailVisibilityRuntime:true,dynamicLinkRuntime:true});client.baseUrl=scope.baseUrl;
 const result=await executeDsl(reviewed.dsl,{...scope,client,confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}});assert.equal(result.ok,true,JSON.stringify(result.diagnostics));assert.equal(result.readback.ok,true);
}));

it('passes each nonempty source address unchanged to the native opener and hides an empty link',()=>{
 const source=cleanSourceFile('tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml'),before=draftSourceDraft(source),action=before.scripts.actions[0],original=source.scripts.sources[0];
 const policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture approval')},decisions:[{kind:'native-dynamic-link-button',sourceRef:original.sourceRef,sourceJavascriptSha256:sha(original.javascript),actionId:action.id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]};
 const draft=draftSourceDraft(attachMigrationPolicies(source,policy,scope)),show=draft.scripts.actions.find(a=>a.event==='onLoad'),click=draft.scripts.actions.find(a=>a.event==='onClick');
 for(const [input,expected] of [['https://example.invalid/invoice',true],['http://example.invalid/invoice',true],['/files/invoice.pdf',true],['mailto:invoices@example.invalid',true],['ftp://example.invalid/invoice',true],['javascript:alert(1)',true],['data:text/html,test',true],['  relative file  ',true],[0,true],[false,true],[['a','b'],true],[{value:'https://example.invalid'},true],['',false],[null,false]]){
  const ops=[],calls=[],xform={$$FORM:{current:{}},getValue:id=>{assert.equal(id,'invoiceUrl');return input},setFieldAttr:(id,v)=>ops.push([id,v])},window={open:(url,target)=>calls.push({url,target})};
  Function('MKXFORM','return ('+show.function+')')(xform)();
  Function('MKXFORM','window','return ('+click.function+')')(xform,window)();
  assert.deepEqual(ops,[['invoiceLink',4],...(expected?[['invoiceLink',5]]:[])]);assert.equal(calls.length,expected?1:0);if(expected){assert.equal(calls[0].url,String(input));assert.equal(calls[0].target,'_self')}
 }
});

it('does not allow forged buttons, altered URLs, changed code or omitted policy to cross the execute boundary',async()=>withNetworkGuard(async()=>{
 const source=cleanSourceFile('tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml'),before=draftSourceDraft(source),original=source.scripts.sources[0],policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture approval')},decisions:[{kind:'native-dynamic-link-button',sourceRef:original.sourceRef,sourceJavascriptSha256:sha(original.javascript),actionId:before.scripts.actions[0].id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]},approved=attachMigrationPolicies(source,policy,scope),draft=draftSourceDraft(approved),reviewed=await runAgentReview(approved,draft,{provider:createFakeReviewProvider('accept')});assert.equal(reviewed.ok,true);
 for(const mutate of [d=>delete d.migrationPolicies,d=>d.form.fields.find(f=>f.id==='invoiceLink').componentId='xform-input',d=>d.scripts.actions.find(a=>a.event==='onClick').function+='\nwindow.open("https://evil.invalid");',d=>d.migrationPolicies.decisions[0].sourceUrlFieldId='other',d=>d.scripts.actions.find(a=>a.event==='onLoad').function=d.scripts.actions.find(a=>a.event==='onLoad').function.replace(', 4',', 5')]){
  const bad=structuredClone(reviewed.dsl);mutate(bad);assert.equal(checkTrust(approved,bad).ok,false);const client=new FakeNewoaAdapter('persist');client.baseUrl=scope.baseUrl;const out=await executeDsl(bad,{...scope,client,confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}});assert.equal(out.ok,false);assert.deepEqual(client.transcript(),[]);
 }
}));

it('only accepts the independently reconstructed URL-only source and the verified origin',()=>{
 const path='tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml',source=cleanSourceFile(path),draft=draftSourceDraft(source),a=draft.scripts.actions[0],s=source.scripts.sources[0],base={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:s.sourceRef,sourceJavascriptSha256:sha(s.javascript),actionId:a.id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]};
 for(const mutate of [p=>p.decisions[0].sourceJavascriptSha256=sha('wrong'),p=>p.decisions[0].fieldId='wrong',p=>p.decisions[0].sourceUrlFieldId='fd_note',p=>p.scope.baseUrl='https://other.example.invalid']){
  const changed=structuredClone(base);mutate(changed);assert.throws(()=>draftSourceDraft(attachMigrationPolicies(source,changed,changed.scope)));
 }
 const noPolicy=draftSourceDraft(source);assert.equal(noPolicy.form.fields.find(f=>f.id==='invoiceLink').componentId,'xform-hyperlinks');
});

it('does not hide a source link whose legacy condition is unconditionally true',()=>{
 const source=cleanSourceFile('tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml');
 source.scripts.sources[0].javascript=source.scripts.sources[0].javascript.replace('if (url)', 'if (true)');
 const draft=draftSourceDraft(source),original=source.scripts.sources[0],policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:original.sourceRef,sourceJavascriptSha256:sha(original.javascript),actionId:draft.scripts.actions[0].id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]};
 assert.throws(()=>draftSourceDraft(attachMigrationPolicies(source,policy,scope)),/truthy URL/);
});

it('applies to the real red-reversal source without altering the other actions or workflow',()=>{
 const source=cleanSourceFile('tests/fixtures/source/189438c54dee44ba9869deb439dbc163'),before=draftSourceDraft(source),action=before.scripts.actions.find(a=>a.semanticHints?.dynamicHyperlink?.generatedFieldId==='invoiceLink'),script=source.scripts.sources.find(s=>s.sourceRef===action.sourceRefs[0]);
 const policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:script.sourceRef,sourceJavascriptSha256:sha(script.javascript),actionId:action.id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]};
 const updated=draftSourceDraft(attachMigrationPolicies(source,policy,scope));assert.deepEqual(updated.workflow,before.workflow);assert.equal(updated.scripts.actions.length,before.scripts.actions.length+1);
 for(const old of before.scripts.actions.filter(a=>a.id!==action.id))assert.deepEqual(updated.scripts.actions.find(a=>a.id===old.id),old);
 assert.equal(updated.form.fields.find(f=>f.id==='invoiceLink').componentId,'xform-button');
});

it('rejects changed native button assets before any template write',async()=>withNetworkGuard(async()=>{
 const source=cleanSourceFile('tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml'),base=draftSourceDraft(source),script=source.scripts.sources[0],policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:script.sourceRef,sourceJavascriptSha256:sha(script.javascript),actionId:base.scripts.actions[0].id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]},approved=attachMigrationPolicies(source,policy,scope),reviewed=await runAgentReview(approved,draftSourceDraft(approved),{provider:createFakeReviewProvider('accept')});assert.equal(reviewed.ok,true);
 for(const change of [client=>client.getDynamicLinkAssetSha256=async()=> 'wrong',client=>client.getDetailCellElementRegistry=async()=> 'APP_CONFIG["moduleDigest"]["sys/artifact"] = {};']){
  const client=new FakeNewoaAdapter('persist',{detailVisibilityRuntime:true,dynamicLinkRuntime:true});client.baseUrl=scope.baseUrl;change(client);const result=await executeDsl(reviewed.dsl,{...scope,client,confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}});assert.equal(result.ok,false);assert(result.diagnostics.some(x=>x.code==='safety.dynamic_link_runtime_unverified'));assert.equal(client.transcript().some(x=>x.operation==='add'),false);
 }
}));

it('opens the URL captured at load and isolates snapshots between form instances',()=>{
 const source=cleanSourceFile('tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml'),base=draftSourceDraft(source),s=source.scripts.sources[0],policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:s.sourceRef,sourceJavascriptSha256:sha(s.javascript),actionId:base.scripts.actions[0].id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]},draft=draftSourceDraft(attachMigrationPolicies(source,policy,scope)),load=draft.scripts.actions.find(a=>a.event==='onLoad').function,click=draft.scripts.actions.find(a=>a.event==='onClick').function;
 const make=value=>({value,$$FORM:{current:{}},getValue(){return this.value},setFieldAttr(){}}),a=make('https://example.invalid/first?sig=123'),b=make('relative/second?x=1'),calls=[],browser={open:(...args)=>calls.push(args)};
 Function('MKXFORM','return ('+load+')')(a)();Function('MKXFORM','return ('+load+')')(b)();a.value='https://example.invalid/changed';b.value='';
 Function('MKXFORM','window','return ('+click+')')(a,browser)();Function('MKXFORM','window','return ('+click+')')(b,browser)();
 assert.deepEqual(calls,[['https://example.invalid/first?sig=123','_self'],['relative/second?x=1','_self']]);
});

it('preserves an explicit new-window target only when it appears in the source anchor',()=>{
 const source=cleanSourceFile('tests/fixtures/route-validation/native-invoice-link-button/explicit-target/blank_SysFormTemplate.xml');const base=draftSourceDraft(source),s=source.scripts.sources[0],policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:s.sourceRef,sourceJavascriptSha256:sha(s.javascript),actionId:base.scripts.actions[0].id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]},draft=draftSourceDraft(attachMigrationPolicies(source,policy,scope)),load=draft.scripts.actions.find(a=>a.event==='onLoad').function,click=draft.scripts.actions.find(a=>a.event==='onClick').function;
 const xform={$$FORM:{current:{}},getValue:()=>'/invoice',setFieldAttr(){}},calls=[];Function('MKXFORM','return ('+load+')')(xform)();Function('MKXFORM','window','return ('+click+')')(xform,{open:(...args)=>calls.push(args)})();assert.deepEqual(calls,[['/invoice','_blank','noopener']]);
});

it('rejects an unannotated native visibility profile without its policy envelope',async()=>{
 const {nativeDynamicLinkVisibility}=await import('../../src/dsl/native-dynamic-link-button.js');
 const {migrationPolicyDslDiagnostics}=await import('../../src/translator/approved-migration-policies.js');
 const fn=nativeDynamicLinkVisibility({buttonId:'invoiceLink',sourceRef:'source.test',target:'_self',urlFieldId:'invoiceUrl'});
 const diagnostics=migrationPolicyDslDiagnostics({scripts:{actions:[{id:'forged',event:'onLoad',scope:'global',function:fn}]}});
 assert(diagnostics.some(d=>d.code==='dsl.migration_policy_envelope_required'));
});

it('rejects other source scripts that redefine the legacy getter or load registration',()=>{
 for(const override of ['GetXFormFieldById = function(){ return [{value:"different"}] }','window.GetXFormFieldById = function(){}','Com_AddEventListener = function(){}','window.open = function(){}','var browser = window; browser.open = function(){}','Object.create = function(){ return {} }','Object.getOwnPropertyDescriptor = function(){return null}',"$('body').append('<div id=invoiceAnchor></div>')","document.body.innerHTML='<div id=invoiceAnchor></div>'",'this.open = function(){}','var browser = this; browser.open = function(){}','top.open = function(){}','parent.GetXFormFieldById = function(){}','frames[0].open = function(){}','setTimeout`window.open = function(){}`']){
  const source=cleanSourceFile('tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml'),base=draftSourceDraft(source),s=source.scripts.sources[0];source.scripts.sources.push({id:'other',sourceRef:'source.other',javascript:override});
  const policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:s.sourceRef,sourceJavascriptSha256:sha(s.javascript),actionId:base.scripts.actions[0].id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]};
  assert.throws(()=>draftSourceDraft(attachMigrationPolicies(source,policy,scope)),/source-owned/);
 }
});

it('rejects non-text native URL controls even if their legacy metadata says String',async()=>{
 const {applyDynamicLinkButtonPolicies}=await import('../../src/translator/approved-dynamic-link-button.js');
 const source=cleanSourceFile('tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml'),draft=draftSourceDraft(source),a=draft.scripts.actions[0],s=source.scripts.sources[0],decision={kind:'native-dynamic-link-button',sourceRef:s.sourceRef,sourceJavascriptSha256:sha(s.javascript),actionId:a.id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'},policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[decision]},approved=attachMigrationPolicies(source,policy,scope);
 for(const componentId of ['xform-address','xform-radio','xform-select']){const mutated=structuredClone(draft);mutated.form.fields.find(f=>f.id==='invoiceUrl').componentId=componentId;assert.throws(()=>applyDynamicLinkButtonPolicies(approved,mutated,[decision]),/native.*String/i)}
});

it('binds the generated button to a unique rendered source anchor and its original row',()=>{
 const source=cleanSourceFile('tests/fixtures/source/189438c54dee44ba9869deb439dbc163'),base=draftSourceDraft(source),action=base.scripts.actions.find(a=>a.semanticHints?.dynamicHyperlink?.generatedFieldId==='invoiceLink'),script=source.scripts.sources.find(s=>s.sourceRef===action.sourceRefs[0]),witness=script.semanticFacts?.dynamicLinkAnchorWitness;
 assert.ok(witness);assert.equal(witness.containerId,'inoiceUrlA');assert.equal(witness.row,9);assert.equal(witness.column,2);
 const policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:script.sourceRef,sourceJavascriptSha256:sha(script.javascript),actionId:action.id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]},out=draftSourceDraft(attachMigrationPolicies(source,policy,scope)),rows=out.form.layout.mkTree.map(x=>x.id);
 assert(rows.indexOf('layout.row-8')<rows.indexOf('layout.generated-invoiceLink'));assert(rows.indexOf('layout.generated-invoiceLink')<rows.indexOf('layout.row-10'));const linkRow=out.form.layout.mkTree.find(row=>row.id==='layout.generated-invoiceLink');assert.equal(linkRow.componentId,'xform-multi-row-table-layout');assert.equal(linkRow.props.columns,5);assert.equal(linkRow.children[0].column,2);assert.equal(linkRow.children[0].colspan,3);
});

it('fails closed when the source anchor is missing, duplicated or conditionally gated',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');const original=fs.readFileSync('tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml','utf8'),anchor='&lt;div id="invoiceAnchor"&gt;&lt;/div&gt;';
 for(const replacement of ['',anchor+anchor,'&lt;xform:viewShow&gt;'+anchor+'&lt;/xform:viewShow&gt;']){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mk-link-witness-'));try{const file=path.join(dir,'test_SysFormTemplate.xml');fs.writeFileSync(file,original.replace(anchor,replacement));const source=cleanSourceFile(file),draft=draftSourceDraft(source),s=source.scripts.sources[0],a=draft.scripts.actions[0],policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:s.sourceRef,sourceJavascriptSha256:sha(s.javascript),actionId:a.id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]};assert.throws(()=>draftSourceDraft(attachMigrationPolicies(source,policy,scope)),/anchor witness/);}finally{fs.rmSync(dir,{recursive:true,force:true})}}
});

it('does not open a pre-existing or inherited foreign snapshot after the button is hidden',()=>{
 const source=cleanSourceFile('tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml'),base=draftSourceDraft(source),s=source.scripts.sources[0],policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:s.sourceRef,sourceJavascriptSha256:sha(s.javascript),actionId:base.scripts.actions[0].id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]},draft=draftSourceDraft(attachMigrationPolicies(source,policy,scope)),load=draft.scripts.actions.find(a=>a.event==='onLoad').function,click=draft.scripts.actions.find(a=>a.event==='onClick').function;
 for(const state of [{invoiceLink:'https://foreign.invalid'},Object.create({invoiceLink:'https://foreign.invalid'})]){const form={__mkDynamicLinkSnapshotV1:state},xform={$$FORM:{current:form},getValue:()=>'',setFieldAttr(){}},calls=[];Function('MKXFORM','return ('+load+')')(xform)();Function('MKXFORM','window','return ('+click+')')(xform,{open:(...args)=>calls.push(args)})();assert.deepEqual(calls,[])}
});

it('rejects a designer script whose runtime JSP anchor or script no longer agrees',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');const file='tests/fixtures/source/189438c54dee44ba9869deb439dbc163/1894390490578c520c906ec4e88b950d_SysFormTemplate.xml',original=fs.readFileSync(file,'utf8'),offset=original.lastIndexOf('<string>fdDisplayJsp</string>');assert(offset>0);
 for(const [needle,replacement] of [['id=&quot;inoiceUrlA&quot;','id=&quot;differentAnchor&quot;'],['查看发票','不同的链接']]){const pos=original.indexOf(needle,offset);assert(pos>offset);const altered=original.slice(0,pos)+replacement+original.slice(pos+needle.length),dir=fs.mkdtempSync(path.join(os.tmpdir(),'mk-link-runtime-'));try{const temp=path.join(dir,'input_SysFormTemplate.xml');fs.writeFileSync(temp,altered);const source=cleanSourceFile(temp),draft=draftSourceDraft(source),a=draft.scripts.actions.find(x=>x.semanticHints?.dynamicHyperlink?.generatedFieldId==='invoiceLink'),s=source.scripts.sources.find(x=>x.sourceRef===a.sourceRefs[0]),policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:s.sourceRef,sourceJavascriptSha256:sha(s.javascript),actionId:a.id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]};assert.throws(()=>draftSourceDraft(attachMigrationPolicies(source,policy,scope)),/anchor witness/);}finally{fs.rmSync(dir,{recursive:true,force:true})}}
});

it('rejects a runtime-only script that aliases window or overrides Object methods',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');const original=fs.readFileSync('tests/fixtures/source/189438c54dee44ba9869deb439dbc163/1894390490578c520c906ec4e88b950d_SysFormTemplate.xml','utf8'),start=original.lastIndexOf('<string>fdDisplayJsp</string>'),anchor=original.indexOf('id=&quot;inoiceUrlA&quot;',start);assert(anchor>start);
 for(const code of ['var browser = window; browser.open = function(){};','Object.create = function(){return {}};']){const insertion='&lt;script&gt;'+code+'&lt;/script&gt;',pos=original.indexOf('&lt;script&gt;',anchor),changed=original.slice(0,pos)+insertion+original.slice(pos),dir=fs.mkdtempSync(path.join(os.tmpdir(),'mk-link-alias-'));try{const file=path.join(dir,'test_SysFormTemplate.xml');fs.writeFileSync(file,changed);const source=cleanSourceFile(file),draft=draftSourceDraft(source),a=draft.scripts.actions.find(x=>x.semanticHints?.dynamicHyperlink?.generatedFieldId==='invoiceLink'),s=source.scripts.sources.find(x=>x.sourceRef===a.sourceRefs[0]),policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:s.sourceRef,sourceJavascriptSha256:sha(s.javascript),actionId:a.id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]};assert.throws(()=>draftSourceDraft(attachMigrationPolicies(source,policy,scope)),/anchor witness/);}finally{fs.rmSync(dir,{recursive:true,force:true})}}
});

it('rejects a self-consistent anchor witness whose raw hashes differ from the URL source facts',async()=>{
 const {canonicalJson}=await import('../../src/agent-review/digest.js');const source=cleanSourceFile('tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml'),script=source.scripts.sources[0],w=script.semanticFacts.dynamicLinkAnchorWitness;assert(w);w.runtimeHtmlSha256='0'.repeat(64);const {witnessSha256,...payload}=w;w.witnessSha256=createHash('sha256').update(canonicalJson(payload)).digest('hex');const base=draftSourceDraft(source),policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:script.sourceRef,sourceJavascriptSha256:sha(script.javascript),actionId:base.scripts.actions[0].id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]};assert.throws(()=>draftSourceDraft(attachMigrationPolicies(source,policy,scope)),/anchor witness/);
});

it('rejects a source draft missing a runtime script recorded by the raw witness',()=>{
 const source=cleanSourceFile('tests/fixtures/source/189438c54dee44ba9869deb439dbc163'),base=draftSourceDraft(source),action=base.scripts.actions.find(a=>a.semanticHints?.dynamicHyperlink?.generatedFieldId==='invoiceLink'),script=source.scripts.sources.find(s=>s.sourceRef===action.sourceRefs[0]);source.scripts.sources=source.scripts.sources.filter(s=>s.sourceRef===script.sourceRef);const policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:script.sourceRef,sourceJavascriptSha256:sha(script.javascript),actionId:action.id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]};assert.throws(()=>draftSourceDraft(attachMigrationPolicies(source,policy,scope)),/anchor witness/);
});

it('does not witness inert scripts, ambiguous source rows or unpreserved visible content',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');const raw=fs.readFileSync('tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml','utf8'),anchor='&lt;div id="invoiceAnchor"&gt;&lt;/div&gt;',open='&lt;script&gt;',close='&lt;/script&gt;';
 const variants=[
  raw.replace(open,'&lt;!-- '+open).replace(close,close+' --&gt;'),
  raw.replace(open,'&lt;%-- '+open).replace(close,close+' --%&gt;'),
  raw.replace(open,'&lt;textarea&gt;'+open).replace(close,close+'&lt;/textarea&gt;'),
  raw.replace(open,'&lt;script type="text/plain"&gt;'),
  raw.replace(open,'&lt;script type="application/json"&gt;'),
  raw.replace(open,'&lt;script type="module"&gt;'),
  raw.replace(open,'&lt;script async&gt;'),
  raw.replace('&lt;a href=', '&amp;lt;a href='),
  raw.replace(anchor,'&lt;span&gt;MUST-PRESERVE&lt;/span&gt;'+anchor),
  raw.replace(anchor,'&lt;div id="invoiceAnchor" onclick="updateLedger()"&gt;&lt;/div&gt;'),
  raw.replace(anchor,'&lt;div id="invoiceAnchor" name="anchorMarker"&gt;&lt;/div&gt;'),
  raw.replace(anchor,'&lt;div id="invoiceAnchor" inert&gt;&lt;/div&gt;'),
  raw.replace(anchor,'&lt;div id="invoiceAnchor" popover&gt;&lt;/div&gt;'),
  raw.replace(anchor,'&lt;div id="invoiceAnchor" class="hidden"&gt;&lt;/div&gt;'),
  raw.replace(anchor,'&lt;div inert&gt;'+anchor+'&lt;/div&gt;'),
  raw.replace(anchor,'&lt;div popover&gt;'+anchor+'&lt;/div&gt;'),
  raw.replace('&lt;table id="fixtureRoot"&gt;', '&lt;div inert&gt;&lt;table id="fixtureRoot"&gt;').replace('&lt;/tbody&gt;&lt;/table&gt;</string></void>', '&lt;/tbody&gt;&lt;/table&gt;&lt;/div&gt;</string></void>'),
  raw.replace(anchor,'&lt;div style="display:none"&gt;&lt;xform:xtext property="extendDataFormInfo.value(invoiceUrl)" onValueChange="updateLedger()" /&gt;&lt;/div&gt;'+anchor),
  raw.replace(anchor,'&lt;style&gt;#invoiceAnchor {display:none}&lt;/style&gt;'+anchor),
  raw.replace('&lt;table id="fixtureRoot"&gt;', '&lt;base target="_blank"&gt;&lt;table id="fixtureRoot"&gt;'),
  raw.replace(anchor,'&lt;div id="invoiceAnchor" style="visibility:collapse"&gt;&lt;/div&gt;'),
  raw.replace(anchor,'&lt;div id="invoiceAnchor" style="font-size:0"&gt;&lt;/div&gt;'),
  raw.replace(anchor,'&lt;div id="invoiceAnchor" style="display:/**/none"&gt;&lt;/div&gt;'),
  raw.replace(anchor,"&lt;div canshow='false' fd_values='{id:&quot;invoiceUrl&quot;,canShow:&quot;false&quot;,dataType:&quot;String&quot;}'&gt;VISIBLE-MUST-PRESERVE&lt;/div&gt;"+anchor),
  raw.replace(anchor,'&lt;input id="otherData"/&gt;'+anchor),
  raw.replace(anchor,anchor+'&lt;script&gt;Com_AddEventListener(window,"load",function(){common_dom_row_set_show_required_reset("fixtureRoot",false,false,false);});&lt;/script&gt;'),
  raw.replace(anchor,anchor+'&lt;script&gt;Com_AddEventListener(window,"load",function(){common_dom_row_set_show_required_reset("extendDataFormInfo.value(invoiceUrl)",false,false,false);});&lt;/script&gt;'),
  raw.replaceAll(' id="fixtureRoot"',''),
  raw.replace('&lt;tr&gt;&lt;td row="0" column="0"&gt;&lt;/td&gt;&lt;/tr&gt;',''),
  raw.replace(anchor,'&lt;table&gt;&lt;tr&gt;&lt;td row="3" column="0"&gt;'+anchor).replace(close,close+'&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;')
 ];
 for(const [index,variant] of variants.entries()){assert.notEqual(variant,raw);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mk-link-inert-'));try{const file=path.join(dir,'test_SysFormTemplate.xml');fs.writeFileSync(file,variant);const source=cleanSourceFile(file);assert.equal(source.scripts?.sources?.some(s=>s.semanticFacts?.dynamicLinkAnchorWitness),false,'variant '+index);}finally{fs.rmSync(dir,{recursive:true,force:true})}}
});

it('rejects another target action that reaches the form-private snapshot state',async()=>{
 const {nativeDynamicLinkDslDiagnostics}=await import('../../src/dsl/native-dynamic-link-button.js');const source=cleanSourceFile('tests/fixtures/route-validation/native-invoice-link-button/route-invoice-button_SysFormTemplate.xml'),base=draftSourceDraft(source),s=source.scripts.sources[0],policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture-only',evidenceSha256:sha('fixture')},decisions:[{kind:'native-dynamic-link-button',sourceRef:s.sourceRef,sourceJavascriptSha256:sha(s.javascript),actionId:base.scripts.actions[0].id,fieldId:'invoiceLink',sourceUrlFieldId:'invoiceUrl',sourceReadPolicy:'native-current-value'}]},draft=draftSourceDraft(attachMigrationPolicies(source,policy,scope));draft.scripts.actions.push({id:'foreign',event:'onLoad',scope:'global',function:'function onLoad(){ MKXFORM.$$FORM.current.__mkDynamicLinkSnapshotV1.invoiceLink = "other"; }'});assert(nativeDynamicLinkDslDiagnostics(draft).some(d=>d.code==='dsl.native_dynamic_link_profile_invalid'));
});
