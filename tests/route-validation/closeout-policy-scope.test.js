import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {it} from 'node:test';
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {cleanSnapshot,sourceSnapshot} from '../../src/batch/intake.js';
import {draftSourceDraft} from '../../src/translator/index.js';
import {attachMigrationPolicies,migrationPolicySourceDigest} from '../../src/translator/approved-migration-policies.js';
import {runAgentReview} from '../../src/agent-review/index.js';
import {sha256Digest} from '../../src/agent-review/digest.js';
import {executeDsl} from '../../src/executor/execute.js';
import {closeoutDraftAuthorization} from '../../src/executor/authorization-closeout.js';
import {createFakeReviewProvider} from './fake-review-provider.js';
import {FakeNewoaAdapter} from './fake-newoa-adapter.js';
import {withNetworkGuard} from './network-guard.js';

const scope={baseUrl:'https://scope-fixture.invalid',targetCategoryId:'scope-fixture-category'};
const hash=text=>'sha256:'+createHash('sha256').update(text).digest('hex');
async function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'closeout-policy-scope-'));
 try{
  const original='tests/fixtures/route-validation/approved-unbound-diagnostic';
  for(const file of fs.readdirSync(original))if(file.endsWith('.xml'))fs.copyFileSync(path.join(original,file),path.join(root,file));
  const auth=fs.readFileSync('tests/fixtures/route-validation/everyone-template-authorization/route-everyone_KmReviewTemplate.xml','utf8').replaceAll('route-everyone-template','fixture-unbound-diagnostic-model');
  fs.writeFileSync(path.join(root,'scope_KmReviewTemplate.xml'),auth);
  const raw=cleanSnapshot(sourceSnapshot(root),''),draft=draftSourceDraft(raw),script=raw.scripts.sources.find(s=>s.javascript.includes('console.log('));
  const call=parse(script.javascript,{ecmaVersion:'latest'}).body[0].expression,statement=call.arguments[1].body.body.at(-1);
  const range=node=>({start:node.start,end:node.end,sha256:hash(script.javascript.slice(node.start,node.end))});
  const decision={kind:'omit-unbound-console-diagnostic',sourceRef:script.sourceRef,sourceJavascriptSha256:hash(script.javascript),actionId:draft.scripts.actions.find(a=>a.sourceRefs.includes(script.sourceRef)).id,callback:range(call),diagnostic:{...range(statement),identifier:'debugValue'}};
  const source=attachMigrationPolicies(raw,{version:1,sourceDraftSha256:migrationPolicySourceDigest(raw),scope,authorization:{actor:'synthetic-fixture-only',evidenceSha256:hash('Fixture authorization only, not a real migration grant.')},decisions:[decision]});
  const review=await runAgentReview(source,draftSourceDraft(source),{provider:createFakeReviewProvider('accept')});assert.equal(review.ok,true,JSON.stringify(review.report?.diagnostics));
  return {root,source,dsl:review.dsl};
 }catch(error){fs.rmSync(root,{recursive:true,force:true});throw error;}
}
async function preview(f,operationScope,clientOrigin){
 const target='scope-fixture-target',report={ok:true,status:'written_with_warnings',baseUrl:operationScope.baseUrl,templateId:target,createdFdIds:[target],writeOutcomeUnknown:false,apiStages:[],readback:{ok:true,numberRule:{status:'verified'},partitions:{envelope:'verified',form:'verified',rules:'verified',scripts:'verified',workflow:'verified'}},transferRecord:{status:'recorded',fdTargetId:target,fdOriginalId:f.dsl.workflow.process.templateId}};
 const client=new FakeNewoaAdapter('persist');if(clientOrigin)client.baseUrl=clientOrigin;
 const result=await closeoutDraftAuthorization(f.dsl,{mode:'repair_readers',...operationScope,targetTemplateId:target,credentials:{username:'fixture',encryptedPassword:'fixture'},client,sourceDraft:f.source,priorSourceDraft:f.source,priorDsl:f.dsl,priorExecutionReport:report,expectedDslDigest:sha256Digest(f.dsl),expectedPriorDslDigest:sha256Digest(f.dsl),expectedPriorReportDigest:sha256Digest(report),testHistoricalLockRoot:path.join(f.root,'history')});
 return {result,client};
}
for(const operationScope of [{...scope,baseUrl:'https://other-scope.invalid'},{...scope,targetCategoryId:'other-category'}])it('closeout rejects an approved policy outside '+JSON.stringify(operationScope)+' before login',async()=>withNetworkGuard(async()=>{
 const f=await fixture();try{const {result,client}=await preview(f,operationScope);assert.equal(result.ok,false);assert.ok(result.diagnostics.some(d=>d.code==='authorization_closeout.migration_policy_scope_mismatch'));assert.deepEqual(client.transcript(),[]);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
}));
it('matching policy scope continues into ordinary native validation without bypassing it',async()=>withNetworkGuard(async()=>{
 const f=await fixture();try{const {result,client}=await preview(f,scope);assert.equal(result.ok,false);assert.equal(result.diagnostics.some(d=>d.code==='authorization_closeout.migration_policy_scope_mismatch'),false);assert.ok(client.transcript().some(call=>call.operation==='login'));assert.equal(client.transcript().some(call=>['add','update','add-transfer-record'].includes(call.operation)),false);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
}));

it('closeout refuses a client declaring another origin before login',async()=>withNetworkGuard(async()=>{const f=await fixture();try{const {result,client}=await preview(f,scope,'https://foreign-client.invalid');assert.equal(result.ok,false);assert.ok(result.diagnostics.some(d=>d.code==='authorization_closeout.client_origin_mismatch'));assert.deepEqual(client.transcript(),[]);}finally{fs.rmSync(f.root,{recursive:true,force:true});}}));

it('ordinary policy execution also rejects a differently rooted client before login',async()=>withNetworkGuard(async()=>{const f=await fixture();try{const client=new FakeNewoaAdapter('persist');client.baseUrl='https://foreign-client.invalid';const result=await executeDsl(f.dsl,{...scope,confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'},client});assert.equal(result.ok,false);assert.ok(result.diagnostics.some(d=>d.code==='execute.client_origin_mismatch'));assert.deepEqual(client.transcript(),[]);}finally{fs.rmSync(f.root,{recursive:true,force:true});}}));
