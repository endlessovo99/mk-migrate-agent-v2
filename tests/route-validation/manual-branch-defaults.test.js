import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {fileURLToPath} from 'node:url';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {runAgentReview} from '../../src/agent-review/index.js';
import {buildDryRunPlan} from '../../src/executor/dry-run.js';
import {executeDsl} from '../../src/executor/execute.js';
import {selectDefaultBranchEdge} from '../../src/executor/persistence/branch-defaults.js';
import {FakeNewoaAdapter} from './fake-newoa-adapter.js';
import {createFakeReviewProvider} from './fake-review-provider.js';
import {withNetworkGuard} from './network-guard.js';

async function run(kind,mutate){return withNetworkGuard(async()=>{
 const source=cleanSourceFile(fileURLToPath(new URL(`../fixtures/route-validation/manual-branch-defaults/${kind}`,import.meta.url)));
 const draft=draftSourceDraft(source);
 const review=await runAgentReview(source,draft,{provider:createFakeReviewProvider('accept'),reviewedAt:'2026-07-10T00:00:00.000Z'});
 assert.equal(review.ok,true,JSON.stringify(review.report));
 const dsl=review.dsl;assert.equal(buildDryRunPlan(dsl).ok,true);
 class Adapter extends FakeNewoaAdapter{
  async getTemplate(id){const value=await super.getTemplate(id);if(this.updated&&mutate){const content=JSON.parse(value.mechanisms.lbpmTemplate[0].fdContent);mutate(content);value.mechanisms.lbpmTemplate[0].fdContent=JSON.stringify(content);}return value;}
  async getWorkflowTemplateDetail(arg){const value=await super.getWorkflowTemplateDetail(arg);if(mutate){const content=JSON.parse(value.fdContent);mutate(content);value.fdContent=JSON.stringify(content);}return value;}
 }
 const client=new Adapter('persist',{templateAuthorization:dsl.template?.authorization,workflowCooperationDefault:'2'});
 const execution=await executeDsl(dsl,{client,credentials:{username:'fake',encryptedPassword:'fake'},confirmWrite:true,targetCategoryId:'route-category-id',now:new Date('2026-07-10T00:00:00Z'),transferRecordIdFactory:()=>`route-manual-default-${kind}`});
 return {dsl,execution,client,transcript:client.transcript()};
});}
function routes(result){return JSON.parse(result.client.workflowDraft.fdContent).elements.filter(e=>e.sourceRef==='N35');}
function defaultIds(result){return routes(result).filter(e=>e.defaultTrend===true).map(e=>e.id);}
const expectations=[['none',[]],['named-other',['L44']],['explicit',['L45']],['two-explicit',['L44']]];

describe('manual branch default expected projection public fake route',()=>{
 for(const [kind,ids] of expectations)it(`${kind}: writer native edges verify and record exactly the existing selected default`,async()=>{
  const result=await run(kind);
  assert.equal(result.dsl.workflow.nodes.find(n=>n.id==='N35').type,'manualBranch');
  assert.equal(result.dsl.workflow.nodes.find(n=>n.id==='N35').decisionType,'1');
  assert.deepEqual(defaultIds(result),ids);
  assert.equal(result.execution.ok,true,JSON.stringify(result.execution.diagnostics));
  assert.equal(result.execution.readback.partitions.workflow,'verified');
  assert.equal(result.execution.transferRecord.status,'recorded');
  assert.equal(result.transcript.filter(e=>e.operation==='add').length,1);
  assert.equal(result.transcript.filter(e=>e.operation==='add-transfer-record').length,1);
  const record=result.transcript.find(e=>e.operation==='add-transfer-record');
  assert.equal(record.sourceTemplateId,'route-manual-branch-template');
  assert.equal(record.targetTemplateId,result.execution.templateId);
  assert.equal(routes(result).every(e=>e.formulaType==='rule'&&e.formula===undefined),true);
 });
 for(const [kind,mutate,expectedIds] of [
  ['named-other',c=>{c.elements.find(e=>e.id==='L44').defaultTrend=false;},['L44']],
  ['named-other',c=>{c.elements.find(e=>e.id==='L44').defaultTrend=false;c.elements.find(e=>e.id==='L45').defaultTrend=true;},['L44','L45']],
  ['none',c=>{c.elements.find(e=>e.id==='L45').defaultTrend=true;},['L45']],
  ['two-explicit',c=>{c.elements.find(e=>e.id==='L45').defaultTrend=true;},['L45']]
 ])it(`${kind}: default mutation ${expectedIds.join(',')} fails before transfer record`,async()=>{
  const r=await run(kind,mutate);
  assert.equal(r.execution.ok,false);
  assert.equal(r.execution.status,'readback_failed');
  assert.deepEqual(r.execution.diagnostics.filter(d=>d.level==='error').map(d=>d.invariantKey).sort(),expectedIds.map(id=>`workflow.edges.${id}.isDefault`).sort());
  assert.equal(r.transcript.some(e=>e.operation==='add-transfer-record'),false);
 });
 it('retains explicit > exact 其他 > tautology and stable first explicit priority',()=>{
  const edges=[{id:'A',name:'其他'},{id:'B',condition:'1==1'},{id:'C',isDefault:true},{id:'D',attributes:{isDefault:'true'}}];
  assert.equal(selectDefaultBranchEdge(edges).id,'C');
  assert.equal(selectDefaultBranchEdge(edges.slice(0,2)).id,'A');
  assert.equal(selectDefaultBranchEdge([{id:'A',name:'其他公司'},{id:'B',condition:'true'}]).id,'B');
  assert.equal(selectDefaultBranchEdge([{id:'A',name:'A'},{id:'B',name:'B'}]),undefined);
 });
});
