import assert from 'node:assert/strict';
import {it} from 'node:test';
import {createTrustedMigrationDsl} from '../../src/dsl/trust.js';
import {buildDryRunPlan} from '../../src/executor/dry-run.js';
import {executeDsl} from '../../src/executor/execute.js';
import {resolveControlEventSupport} from '../../src/dsl/scripts.js';
import {FakeNewoaAdapter} from './fake-newoa-adapter.js';
import {withNetworkGuard} from './network-guard.js';
import {formAttr,projectTemplate} from '../helpers/persistence.js';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
const fixture='tests/fixtures/route-validation/detail-org-hydration/route-detail-org_SysFormTemplate.xml';
it('preserves a legacy organization hydration callback on the changed detail row',()=>{
const d=draftSourceDraft(cleanSourceFile(fixture));const a=d.scripts.actions.find(a=>a.event==='onChange'&&a.controlId==='fd_xz_name');
assert.ok(a,'The reachable detail-address callback must become a row-scoped action rather than remain an unresolved global load script.');
assert.equal(a.tableId,'fd_3242f3c67e44fc');assert.equal(a.translationStatus,'mapped');assert.match(a.function,/sysorg\.getPersonByPersonId/);assert.match(a.function,/MKXFORM\.updateControl/);
});

it('trusts, dry-runs, persists and API reads back the same row-bound action with fake clients',async()=>withNetworkGuard(async()=>{
const source=cleanSourceFile(fixture),draft=draftSourceDraft(source);
const dsl=createTrustedMigrationDsl(source,draft,{externalAgentReviewed:true,reviewerName:'route-test',checkedAt:'2026-10-17T00:00:00.000Z'});
assert.equal(buildDryRunPlan(dsl).ok,true);const client=new FakeNewoaAdapter('persist');
const result=await executeDsl(dsl,{client,confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'route-user',encryptedPassword:'route-password'},baseUrl:'https://p-sit.onewo.com',now:new Date('2026-10-17T00:00:00.000Z'),transferRecordIdFactory:()=> 'route0000000000000000000000000000000'});
assert.equal(result.ok,true,JSON.stringify(result.diagnostics));assert.equal(result.readback.status,'verified');assert.equal(result.transferRecord.status,'recorded');
assert.equal(result.readback.form.scripts.actions.length,1);
const persisted=JSON.stringify(formAttr(projectTemplate(dsl)).controlAction);
assert.match(persisted,/getPersonByPersonId/);assert.match(persisted,/updateControl/);assert.doesNotMatch(persisted,/\$\{table:/);
}));
it('does not enable an unproved address event alongside the proved onChange',()=>{
assert.equal(resolveControlEventSupport({kind:'detail',field:{componentId:'xform-address'}},'onFocus').status,'unsupported');
});

it('closes only the current export name domain after binding all Designer and Display scripts',async()=>withNetworkGuard(async()=>{
const full='tests/fixtures/route-validation/detail-org-hydration/route-detail-org-domain_SysFormTemplate.xml';
const source=cleanSourceFile(full),draft=draftSourceDraft(source);
const domain=source.scripts.sources[0].semanticFacts.staticDetailOrgEventDomain;
assert.equal(domain.scope,'current-export-static-doclist-controls');assert.equal(domain.designerScriptCount,1);assert.equal(domain.displayScriptCount,5);
assert.deepEqual(domain.displayScriptKinds,['doclist-template-library','doclist-static-table-registration','doclist-static-default-rows','doclist-static-width-only','authored-callback']);
assert.equal(draft.scripts.actions.length,1);const action=draft.scripts.actions[0];
assert.equal(action.semanticHints.detailOrgHydration.absentBranches.length,3);
for(const branch of action.semanticHints.detailOrgHydration.absentBranches)assert.equal(domain.sourceControlIds.includes(branch.controlId),false);
const dsl=createTrustedMigrationDsl(source,draft,{externalAgentReviewed:true,reviewerName:'route-test',checkedAt:'2026-10-17T00:00:00.000Z'});
assert.equal(buildDryRunPlan(dsl).ok,true);
const result=await executeDsl(dsl,{client:new FakeNewoaAdapter('persist'),confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'route-user',encryptedPassword:'route-password'},baseUrl:'https://p-sit.onewo.com',now:new Date('2026-10-17T00:00:00.000Z'),transferRecordIdFactory:()=> 'route0000000000000000000000000000000'});
assert.equal(result.ok,true,JSON.stringify(result.diagnostics));assert.equal(result.readback.status,'verified');assert.equal(result.transferRecord.status,'recorded');
const unsafe=structuredClone(source);unsafe.scripts.sources[0].semanticFacts.staticDetailOrgEventDomain=undefined;
assert.equal(draftSourceDraft(unsafe).scripts.actions.some(a=>a.translationStatus==='needs_review'),true);
}));
