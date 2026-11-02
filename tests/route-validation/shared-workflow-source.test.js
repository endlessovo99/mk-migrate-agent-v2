import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { cleanSourceFile, draftSourceDraft } from '../../src/translator/index.js';
import { createTrustedMigrationDsl, checkTrust } from '../../src/dsl/trust.js';
import { buildDryRunPlan } from '../../src/executor/dry-run.js';
import { executeDsl } from '../../src/executor/execute.js';
import { FakeNewoaAdapter } from './fake-newoa-adapter.js';
import { withNetworkGuard } from './network-guard.js';
const fixture='tests/fixtures/route-validation/shared-workflow';
const binding='route-business_LbpmTemplate.xml', process='route-kmreview-named_LbpmProcessDefinition.xml';
it('accepts the uniquely source-bound business-to-common workflow without rewriting identities',()=>{
  const source=cleanSourceFile(fixture);
  assert.equal(source.source.sharedWorkflow.businessTemplateId,'route-kmreview-named-template');
  assert.equal(source.source.sharedWorkflow.commonTemplateId,'route-shared-common');
  assert.equal(source.source.sharedWorkflow.processId,'route-kmreview-named-process');
  assert.equal(source.workflow.process.templateId,'route-shared-common');
  assert.ok(draftSourceDraft(source).workflow.nodes.length>0);
});
it('rejects unrelated, missing, duplicated or contradictory association evidence',()=>{
  for(const [file,oldText,newText] of [
    [binding,'route-shared-common','route-different-common'],
    [process,'com.landray.kmss.sys.lbpm.engine.persistence.model.LbpmProcessDefinition','invalid-process-class'],
    [binding,'route-kmreview-named-template','route-different-business'],
    [binding,'<boolean>false</boolean>','<boolean>true</boolean>'],
    [binding,'<string>fdCommon</string>','<string>unrelated</string>'],
    [process,'<string>fdTemplateId</string><string>route-shared-common</string>','<string>fdTemplateId</string><string>other</string>'],
    [binding,'<string>fdId</string><string>route-business-lbpm</string>','<string>fdId</string><string>route-business-lbpm</string></void><void method="put"><string>fdId</string><string>duplicate</string>'],
  ]){
    const dir=mkdtempSync(join(tmpdir(),'shared-workflow-test-'));
    try { cpSync(fixture,dir,{recursive:true});let path=join(dir,file);let raw=readFileSync(path,'utf8');assert.ok(raw.includes(oldText));writeFileSync(path,raw.replace(oldText,newText));assert.throws(()=>cleanSourceFile(dir)); } finally {rmSync(dir,{recursive:true,force:true});}
  }
});

it('keeps the source-bound common graph through the offline fake execution and readback',async()=>withNetworkGuard(async()=>{
  const source=cleanSourceFile(fixture), draft=draftSourceDraft(source);
  const dsl=createTrustedMigrationDsl(source,draft,{externalAgentReviewed:true,reviewerName:'route-test'});
  assert.equal(buildDryRunPlan(dsl).ok,true);
  const result=await executeDsl(dsl,{client:new FakeNewoaAdapter('persist'),confirmWrite:true,
    targetCategoryId:'route-category-id',credentials:{username:'route-user',encryptedPassword:'route-password'},
    baseUrl:'https://p-sit.onewo.com'});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.equal(result.readback.partitions.workflow,'verified');
  assert.equal(result.transferRecord.status,'recorded');
  assert.equal(result.transferRecord.fdOriginalId,'route-kmreview-named-template');
  const changed=structuredClone(dsl);changed.derivedFrom.originalTemplateId='wrong';
  assert.equal(checkTrust(source,changed).ok,false);
  const omitted=structuredClone(dsl);delete omitted.derivedFrom.originalTemplateId;
  assert.equal(checkTrust(source,omitted).ok,false);
}));

it('records the business source when common process content omits its template description',async()=>withNetworkGuard(async()=>{
  const dir=mkdtempSync(join(tmpdir(),'shared-workflow-blank-'));
  try {
    cpSync(fixture,dir,{recursive:true});const file=join(dir,process),raw=readFileSync(file,'utf8');
    const changed=raw.replace(/ description=&quot;modelName=.*?&quot;/,'');assert.notEqual(changed,raw);writeFileSync(file,changed);
    const source=cleanSourceFile(dir),draft=draftSourceDraft(source);assert.equal(source.workflow.process.templateId,'');
    const dsl=createTrustedMigrationDsl(source,draft,{externalAgentReviewed:true,reviewerName:'route-test'});
    const result=await executeDsl(dsl,{client:new FakeNewoaAdapter('persist'),confirmWrite:true,
      targetCategoryId:'route-category-id',credentials:{username:'route-user',encryptedPassword:'route-password'},
      baseUrl:'https://p-sit.onewo.com'});
    assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
    assert.equal(result.transferRecord.fdOriginalId,'route-kmreview-named-template');
  } finally {rmSync(dir,{recursive:true,force:true});}
}));
