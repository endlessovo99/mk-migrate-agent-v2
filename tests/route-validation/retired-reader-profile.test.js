import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {it} from 'node:test';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {runAgentReview} from '../../src/agent-review/index.js';
import {repairLockedDraft,lockedDraftEvidenceDigest} from '../../src/executor/locked-draft-repair.js';
import {main} from '../../src/cli/main.js';
import {createFakeReviewProvider} from './fake-review-provider.js';
import {withNetworkGuard} from './network-guard.js';
const fixture='tests/fixtures/route-validation/everyone-template-authorization';
const contract=JSON.parse(fs.readFileSync('tests/fixtures/route-validation/retired-reader-profile/contract.json'));
async function input(){const source=cleanSourceFile(fixture),review=await runAgentReview(source,draftSourceDraft(source),{provider:createFakeReviewProvider('accept')});assert.equal(review.ok,true);const report={status:'readback_failed'};return {source,dsl:review.dsl,report,options:{sourceDraft:source,priorExecutionReport:report,repairKind:'template_authorization',authorizationProfile:contract.profile,expectedDslDigest:lockedDraftEvidenceDigest(review.dsl),expectedPriorReportDigest:lockedDraftEvidenceDigest(report)}};}
it('retired aggregate-only profile cannot reach native I/O from the executor',async()=>withNetworkGuard(async()=>{const f=await input();let calls=0;const result=await repairLockedDraft(f.dsl,{...f.options,client:{login:async()=>{calls++;}}});assert.equal(result.ok,false);assert.ok(result.diagnostics.some(d=>d.code===contract.expectedCode));assert.equal(calls,contract.expectedTargetRequests);}));
it('CLI explicitly rejects the retired profile instead of silently invoking ordinary recovery',async()=>withNetworkGuard(async()=>{
 const f=await input(),root=fs.mkdtempSync(path.join(os.tmpdir(),'retired-profile-cli-')),oldLog=console.log,oldExit=process.exitCode,output=[];
 try{
  fs.writeFileSync(path.join(root,'dsl.json'),JSON.stringify(f.dsl));fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(f.report));console.log=value=>output.push(String(value));process.exitCode=undefined;let error;
  try{await main(['repair-locked-draft',path.join(root,'dsl.json'),'--source',fixture,'--prior-execution-report',path.join(root,'report.json'),'--repair-kind','template_authorization','--authorization-profile',contract.profile,'--expected-dsl-digest',f.options.expectedDslDigest,'--expected-prior-report-digest',f.options.expectedPriorReportDigest],{env:{}});}catch(e){error=e;}
  if(error)assert.match(error.message,/retired/);else{const result=JSON.parse(output.at(-1));assert.equal(result.ok,false);if(result.status==='error')assert.match(result.message,/retired/);else assert.ok(result.diagnostics?.some(d=>d.code===contract.expectedCode));}
 }finally{console.log=oldLog;process.exitCode=oldExit;fs.rmSync(root,{recursive:true,force:true});}
}));
