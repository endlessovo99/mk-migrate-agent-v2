import assert from 'node:assert/strict';
import {it} from 'node:test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {NewoaClient} from '../../src/executor/newoa-client.js';
import {resolveWorkflowParticipants} from '../../src/executor/participant-resolver.js';
import {resolveTemplateReadScope,NATIVE_TEMPLATE_READER_CAPABILITY,isNativeEveryone} from '../../src/executor/template-read-scope.js';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {validateMigrationDsl} from '../../src/dsl/schema.js';
import {templateReadScopeIssues,sourceReadScopeBindingIssues} from '../../src/dsl/template-read-scope.js';

const fixture='tests/fixtures/route-validation/everyone-template-authorization';
const contract=JSON.parse(fs.readFileSync(fixture+'/native-contract.json'));
const everyone={fdId:'tenant-reserved-everyone',fdName:'All users label',fdOrgType:8,fdIsAvailable:true,fdIsBusiness:false,fdAccount:{fdLoginName:'everyone'}};
const source=()=>cleanSourceFile(fixture);
function nativeClient(change={}){return {getKmReviewDesktopDigest:async()=>({[contract.digestKey]:{hash:contract.release}}),getKmReviewTemplateEditSha256:async()=>contract.sha256,getTemplateReaderConfiguration:async()=>({}),searchOrg:async()=>[everyone],getElementInfo:async()=>[everyone],...change};}
function ordinary(member){return {template:{authorization:{readerFlag:true,readers:[member],allReaders:[structuredClone(member)],editors:[],allEditors:[],temporaryReaders:[],temporaryEditors:[]}}};}
const person={type:'user_or_org',name:'Legacy account',sourceId:'old-account',sourceOrgType:8,sourceOrgClass:'com.landray.kmss.sys.organization.model.SysOrgPerson',sourceLoginName:'staff-login',sourceRef:'source.template.authorization.authReaders.0'};

it('versioned native capability matches an independent captured fixture',()=>{
 for(const key of ['digestKey','modulePath','release','sha256'])assert.equal(NATIVE_TEMPLATE_READER_CAPABILITY[key],contract[key]);
});
it('discovers one exact builtin account, then independently looks it up by ID',async()=>{
 const s=source(),calls=[],c=nativeClient({getElementInfo:async(ids,options)=>{calls.push({ids,options});return [everyone];}});
 const b=await resolveTemplateReadScope({template:s.template},{client:c,targetBaseUrl:'https://tenant.invalid'});assert.equal(b.everyone.id,everyone.fdId);assert.equal(b.everyone.loginName,'everyone');assert.deepEqual(calls,[{ids:[everyone.fdId],options:{builtinEvidence:true}}]);
});
it('rejects duplicate discovery, duplicate exact rows, wrong IDs and conflicting login fields',async()=>{
 const s=source();for(const change of [{searchOrg:async()=>[everyone,{...everyone,fdId:'second'}]},{getElementInfo:async()=>[everyone,everyone]},{getElementInfo:async()=>[{...everyone,fdId:'other'}]},{getElementInfo:async()=>[{...everyone,fdLoginName:'conflicting'}]}])await assert.rejects(()=>resolveTemplateReadScope({template:s.template},{client:nativeClient(change),targetBaseUrl:'https://tenant.invalid'}));
});
it('rejects malformed source scopes and configuration rather than throwing unstructured validation errors',async()=>{
 const s=source();for(const value of [null,'everyone',[],{mode:'everyone'},{...s.template.authorization.readScope,evidence:null}]){const a=structuredClone(s.template.authorization);a.readScope=value;assert.ok(templateReadScopeIssues(a).length);assert.ok(sourceReadScopeBindingIssues({...s,template:{...s.template,authorization:a}}).length);}
 for(const config of [[],null,{business:null},{business:[]},{business:{templateEmptyNotUse:true}},{business:{templateEmptyNotUse:null}}])await assert.rejects(()=>resolveTemplateReadScope({template:s.template},{client:nativeClient({getTemplateReaderConfiguration:async()=>config}),targetBaseUrl:'https://tenant.invalid'}));
});
it('ordinary person matching understands native nested account login but rejects conflicts even with fallback permission',async()=>{
 const target={fdId:'current-person',fdName:'Current account',fdOrgType:8,fdIsBusiness:true,fdAccount:{fdLoginName:'staff-login'}};
 const c={searchOrg:async()=>[target],getElementInfo:async()=>[target]};
 const result=await resolveWorkflowParticipants(ordinary(person),{client:c,targetBaseUrl:'https://qas.invalid'});assert.equal(result.dsl.template.authorization.readers[0].id,target.fdId);assert.equal(result.fallbackCount,0);
 await assert.rejects(()=>resolveWorkflowParticipants(ordinary(person),{client:{...c,searchOrg:async()=>[{...target,fdLoginName:'other'}]},targetBaseUrl:'https://oaqas.shanghai-electric.com',allowTemplateAuthorizationFallback:true}));
});
it('rejects conflicting logins in the name search after an empty login search',async()=>{
 const calls=[],target={fdId:'conflicting-person',fdName:person.name,fdOrgType:8,fdIsBusiness:true,fdLoginName:'other-login',fdAccount:{fdLoginName:'staff-login'}};
 const c={searchOrg:async key=>{calls.push(key);return key==='staff-login'?[]:[target];},getElementInfo:async()=>[target]};
 await assert.rejects(()=>resolveWorkflowParticipants(ordinary(person),{client:c,targetBaseUrl:'https://oaqas.shanghai-electric.com',allowTemplateAuthorizationFallback:true}),error=>error.issues.every(issue=>issue.reason==='target_login_identity_conflict'));
 assert.deepEqual(calls,['staff-login',person.name]);
});
it('malformed editor members return schema diagnostics instead of throwing',()=>{
 for(const key of ['editors','allEditors','temporaryEditors']){
  const d=draftSourceDraft(source());d.template.authorization[key]=[null];
  const result=validateMigrationDsl(d);assert.equal(result.ok,false);assert.ok(result.diagnostics.some(x=>x.code==='dsl.template.authorization.member_type'&&x.path===`/template/authorization/${key}/0`));
 }
});
it('does not hide a conflicting duplicate row behind an earlier matching person ID',async()=>{
 const valid={fdId:'same-person',fdName:person.name,fdOrgType:8,fdIsBusiness:true,fdLoginName:'staff-login',fdAccount:{fdLoginName:'staff-login'}},conflicting={...valid,fdAccount:{fdLoginName:'other-login'}};
 for(const useName of [false,true])await assert.rejects(()=>resolveWorkflowParticipants(ordinary(person),{client:{searchOrg:async key=>useName&&key==='staff-login'?[]:[valid,conflicting],getElementInfo:async()=>[valid]},targetBaseUrl:'https://oaqas.shanghai-electric.com',allowTemplateAuthorizationFallback:true}),error=>error.issues.every(x=>x.reason==='target_login_identity_conflict'));
});
it('real client wire columns prove ordinary versus builtin accounts for direct and fallback targets',async()=>{
 for(const kind of ['direct','fallback','missing-evidence','conflicting-exact','ordinary']){
  const columns=[],entity=kind==='ordinary'?{...everyone,fdId:'real-person',fdIsBusiness:true,fdAccount:{fdLoginName:'staff-login'}}:kind==='missing-evidence'?{fdId:everyone.fdId,fdName:'Unknown',fdOrgType:8}:kind==='conflicting-exact'?{...everyone,fdIsBusiness:true,fdLoginName:'other',fdAccount:{fdLoginName:'staff-login'}}:everyone;
  const c=new NewoaClient({baseUrl:'https://oaqas.shanghai-electric.com',fetchImpl:async(url,init)=>{
   const body=JSON.parse(init.body);let data=[];
   if(url.endsWith('/getElementInfo')){columns.push(body.colums);data=[Object.fromEntries(body.colums.flatMap(key=>key==='fdAccount.fdLoginName'&&entity.fdAccount?[['fdAccount',entity.fdAccount]]:Object.hasOwn(entity,key)?[[key,entity[key]]]:[]))];}
   return new Response(JSON.stringify({success:true,data}));
  }});
  const direct={workflow:{nodes:[{id:'N',participants:{mode:'explicit',members:[{type:'user_or_org',id:entity.fdId,name:entity.fdName,targetOrgType:8}]}}]}};
  const run=()=>resolveWorkflowParticipants(kind==='fallback'?ordinary(person):direct,{client:c,targetBaseUrl:c.baseUrl,allowTemplateAuthorizationFallback:true,allowMissingDirectPersonFallback:true,fallbackFdIds:{person:entity.fdId}});
  if(kind==='ordinary')assert.equal((await run()).fallbackCount,0);else await assert.rejects(run,error=>error.issues.some(issue=>['builtin_everyone_scope_required','target_person_builtin_evidence_missing','target_login_identity_conflict'].includes(issue.reason)));
  assert.ok(columns.length>0);for(const value of columns){assert.ok(value.includes('fdIsBusiness'));assert.ok(value.includes('fdAccount.fdLoginName'));}
 }
});
it('does not use unbound everyone as a direct reader, workflow participant or configured person fallback',async()=>{
 const direct={type:'user_or_org',id:everyone.fdId,name:everyone.fdName,targetOrgType:8};
 await assert.rejects(()=>resolveWorkflowParticipants(ordinary(direct),{client:{getElementInfo:async()=>[everyone]},targetBaseUrl:'https://oaqas.shanghai-electric.com',allowMissingDirectPersonFallback:true,allowTemplateAuthorizationFallback:true}));
 await assert.rejects(()=>resolveWorkflowParticipants({workflow:{nodes:[{id:'N',participants:{mode:'explicit',members:[{...person,sourceLoginName:'everyone'}]}}]}},{client:{searchOrg:async()=>[],getElementInfo:async()=>[everyone]},targetBaseUrl:'https://oaqas.shanghai-electric.com'}));
 await assert.rejects(()=>resolveWorkflowParticipants(ordinary(person),{client:{searchOrg:async()=>[],getElementInfo:async()=>[everyone]},targetBaseUrl:'https://oaqas.shanghai-electric.com',fallbackFdIds:{person:everyone.fdId},allowTemplateAuthorizationFallback:true}));
});
it('does not identify a builtin from a label, ordinary business account or missing fields',()=>{
 for(const entity of [{fdId:'x',fdName:'Everyone',fdOrgType:8},{...everyone,fdIsBusiness:true},{...everyone,fdOrgType:16},{...everyone,fdIsAvailable:false},{...everyone,fdAccount:{fdLoginName:'someone'}}])assert.equal(isNativeEveryone(entity),false);
});
it('the real client requests only native read endpoints and explicit builtin evidence columns',async()=>{
 const calls=[],content='native permission fixture bytes';const c=new NewoaClient({baseUrl:'https://tenant.invalid',fetchImpl:async(url,init)=>{calls.push({url,init});if(url.includes('/index.js?'))return new Response(content);if(url.endsWith('/digest.json'))return new Response(JSON.stringify({[contract.digestKey]:{hash:contract.release}}));if(url.endsWith('/getElementInfo'))return new Response(JSON.stringify({success:true,data:[everyone]}));return new Response(JSON.stringify({success:true,data:{}}));}});
 await c.getKmReviewDesktopDigest();assert.equal(await c.getKmReviewTemplateEditSha256({releaseHash:contract.release}),createHash('sha256').update(content).digest('hex'));assert.deepEqual(await c.getTemplateReaderConfiguration(),{});await c.getElementInfo([everyone.fdId],{builtinEvidence:true});
 assert.deepEqual(calls.map(x=>new URL(x.url).pathname),['/web/km-review/desktop/digest.json','/web/km-review/desktop/pages/kmReviewTemplate/edit/index.js','/data/km-review/moduleConfig/getConfiguration','/data/sys-org/sysOrgElementQuery/getElementInfo']);const columns=JSON.parse(calls[3].init.body).colums;assert.ok(columns.includes('fdAccount.fdLoginName'));assert.ok(columns.includes('fdIsBusiness'));assert.ok(columns.includes('fdIsAvailable'));
});
it('rejects duplicate fallback identity rows before a later ordinary row can mask a builtin or conflicting account',async()=>{
 const good={fdId:'configured-person-fallback',fdName:'Approved fallback',fdOrgType:8,fdIsBusiness:true,fdIsAvailable:true,fdAccount:{fdLoginName:'staff-fallback'}};
 for(const bad of [{...good,fdIsBusiness:false,fdAccount:{fdLoginName:'everyone'}},{...good,fdAccount:{fdLoginName:'another-person'}}]){
  await assert.rejects(()=>resolveWorkflowParticipants(ordinary(person),{client:{searchOrg:async()=>[],getElementInfo:async()=>[bad,good]},targetBaseUrl:'https://oaqas.shanghai-electric.com',fallbackFdIds:{person:good.fdId},allowTemplateAuthorizationFallback:true}),error=>error.issues.some(issue=>issue.reason==='fallback_target_ambiguous'));
 }
});
it('does not attest a native reader origin from a client declaring a different root',async()=>{
 const s=source(),calls=[],c=nativeClient({baseUrl:'https://another-tenant.invalid',getKmReviewDesktopDigest:async()=>{calls.push('remote-read');return {[contract.digestKey]:{hash:contract.release}};}});
 await assert.rejects(()=>resolveTemplateReadScope({template:s.template},{client:c,targetBaseUrl:'https://tenant.invalid'}),e=>e.code==='template.read_scope.origin_mismatch');assert.deepEqual(calls,[]);
});
