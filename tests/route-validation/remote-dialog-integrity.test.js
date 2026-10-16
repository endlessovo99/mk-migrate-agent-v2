import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {checkTrust,createTrustedMigrationDsl} from '../../src/dsl/trust.js';
import {checkExecute} from '../../src/dsl/checks.js';
import {buildDryRunPlan} from '../../src/executor/dry-run.js';
import {applyEvidenceBackedPatches,collectSourceRefs} from '../../src/agent-review/review-validation.js';
import {runRouteCase} from './run-route-case.js';
const clean=name=>cleanSourceFile(`tests/fixtures/route-validation/remote-dialog-integrity/${name}_SysFormTemplate.xml`);
const trusted=(source,draft)=>createTrustedMigrationDsl(source,draft,{externalAgentReviewed:true,reviewerName:'negative-regression'});
const lookup=form=>(form.controls||form.fields).find(field=>field.id==='fd_lookup');
test('typed REST preserves only recognized text readonly literals',()=>{
 for(const name of ['rest-string-true','rest-padded-true']){
  const source=clean(name),draft=draftSourceDraft(source);
  assert.equal(lookup(draft.form).props.readOnly,true);
 }
 for(const name of ['rest-false','rest-unknown-primitive','rest-unknown-payload']){
  const source=clean(name),draft=draftSourceDraft(source);
  assert.notEqual(lookup(draft.form).props.readOnly,true);
  const text=JSON.stringify({source,draft});
  for(const canary of ['CANARY015_ENDPOINT_SECRET','CANARY015_AUTH_SECRET','CANARY015_HEADER_SECRET','CANARY015_FLAG_SECRET','CANARY015_OBJECT_SECRET'])assert.equal(text.includes(canary),false);
 }
});
test('unbound remote selectors remain source-backed execution blockers after warning removal',()=>{
 for(const name of ['rest-string-true','sql-generated']){
  const source=clean(name),draft=draftSourceDraft(source);
  draft.review={};
  const dsl=trusted(source,draft);
  assert.equal(checkTrust(source,dsl).ok,false);
  assert.equal(checkExecute(dsl).ok,false);
  assert.equal(buildDryRunPlan(dsl).ok,false);
 }
});
test('generated SQL lookup runtime retains unresolved source behavior',()=>{
 const source=clean('sql-generated'),draft=draftSourceDraft(source),action=draft.scripts.actions[0];
 assert.ok(source.scripts.sources.some(script=>script.javascript.includes('Dialog_List')));
 assert.equal(action.translationStatus,'needs_review');
 assert.equal(action.coverage.status,'uncovered');
 assert.ok(action.coverage.residuals.length);
 assert.ok(!action.semanticHints?.coveredCalculationRanges?.length);
 assert.ok(!action.functionMappings.some(mapping=>mapping.basis==='legacy-runtime-noop'));
});
test('fixed source rejects deleted remote fields, facts, actions and fake bindings',()=>{
 for(const mutate of [
  draft=>{lookup(draft.form).sourceProps={};},
  draft=>{draft.form.fields=draft.form.fields.filter(field=>field.id!=='fd_lookup');},
  draft=>{lookup(draft.form).sourceProps.designerType='inputText';},
  draft=>{lookup(draft.form).sourceProps.remoteDialog={bound:true};},
  draft=>{draft.scripts={actions:[],sources:[],javascript:''};}
 ]){
  const source=clean('sql-generated'),draft=draftSourceDraft(source);mutate(draft);draft.review={};
  const result=checkTrust(source,trusted(source,draft));
  assert.equal(result.ok,false);
  assert.ok(result.diagnostics.some(item=>item.code.startsWith('trust.form.remote_dialog_')));
 }
});
test('fixed remote declarations cannot be hidden by conflicting ordinary or other remote types',()=>{
 for(const type of ['inputText','',null,'SQLDialog']){
  const source=clean('rest-string-true');lookup(source.form).sourceProps.designerType=type;
  const result=checkTrust(source,trusted(source,draftSourceDraft(source)));
  assert.ok(result.diagnostics.some(item=>item.code==='trust.form.remote_dialog_source_type_conflict'));
 }
});
test('duplicate remote source references across main/detail scopes remain ambiguous',()=>{
 const source=clean('rest-string-true'),field=structuredClone(lookup(source.form));
 source.form.detailTables=[{id:'fd_rows',sourceRef:'synthetic.rows',columns:[field]}];
 const result=checkTrust(source,trusted(source,draftSourceDraft(source)));
 assert.ok(result.diagnostics.some(item=>item.code==='trust.form.remote_dialog_source_ref_ambiguous'));
});
test('detail table containers participate in source reference ambiguity',()=>{
 const source=clean('rest-string-true');
 source.form.detailTables=[{id:'fd_rows',sourceRef:lookup(source.form).sourceRef,columns:[]}];
 const result=checkTrust(source,trusted(source,draftSourceDraft(source)));
 assert.ok(result.diagnostics.some(item=>item.code==='trust.form.remote_dialog_source_ref_ambiguous'));
});
test('malformed fields retain structured schema failures',()=>{
 for(const mutate of [
  dsl=>{dsl.form=null;},
  dsl=>{dsl.form.fields[0]=null;},
  dsl=>{dsl.form.fields=[{id:'fd_rows',type:'detailTable',columns:[null]}];},
  dsl=>{dsl.form.fields=[{id:'fd_rows',type:'detailTable',columns:{}}];}
 ]){
  const source=clean('ordinary-input'),dsl=trusted(source,draftSourceDraft(source));mutate(dsl);
  const result=checkExecute(dsl);assert.equal(result.ok,false);assert.ok(result.diagnostics.length);
 }
});
test('public patch application cannot turn fixed-source SQL into a covered empty action',()=>{
 const source=clean('sql-generated'),draft=draftSourceDraft(source),action=draft.scripts.actions[0];
 const patches=Object.entries({function:'',translationStatus:'omitted',coverage:{status:'covered',nativeRules:[],residuals:[]}}).map(([key,value])=>({op:'replace',path:`/scripts/actions/0/${key}`,value,sourceRefs:action.sourceRefs,evidence:['Synthetic unresolved lookup source'],rationale:'Negative regression',confidence:0.99}));
 const result=applyEvidenceBackedPatches(draft,patches,{sourceDraft:source,sourceRefs:collectSourceRefs(source)});
 assert.equal(result.ok,false);
});
test('ordinary input carrying SQL-like metadata stays ordinary',()=>{
 const source=clean('ordinary-input'),draft=draftSourceDraft(source);
 assert.notEqual(lookup(draft.form).props.readOnly,true);
 assert.equal(checkTrust(source,trusted(source,draft)).ok,true);
 assert.equal(checkExecute(trusted(source,draft)).ok,true);
});
for(const id of ['unbound-rest-selector-blocks-before-write','generated-sql-lookup-blocks-before-write'])test(`route refuses unresolved behavior: ${id}`,async()=>{
 const result=await runRouteCase(id);
 assert.equal(result.review.status,'blocked');assert.deepEqual(result.transcript,[]);
 assert.equal(result.execution,undefined);
});
