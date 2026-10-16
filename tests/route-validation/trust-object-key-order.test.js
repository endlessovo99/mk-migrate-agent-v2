import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {applyEvidenceBackedPatches,collectSourceRefs} from '../../src/agent-review/review-validation.js';
import {checkTrust,createTrustedMigrationDsl} from '../../src/dsl/trust.js';
import {sourceNumberEditors} from '../../src/dsl/source-number-editor.js';
import {reviewNativeSelectEmptyEvent} from './fake-review-scenarios/native-select-empty-event.js';
const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,reorder(value[key])])):value;
function selectStages(){
 const source=cleanSourceFile('tests/fixtures/route-validation/native-select-empty-event/select-empty_SysFormTemplate.xml');
 const draft=draftSourceDraft(source),patches=reviewNativeSelectEmptyEvent({dslDraft:draft}).patches;
 const result=applyEvidenceBackedPatches(draft,patches,{sourceDraft:source,sourceRefs:collectSourceRefs(source)});
 assert.equal(result.ok,true);
 const trusted=createTrustedMigrationDsl(source,result.dslDraft,{externalAgentReviewed:true});
 assert.equal(checkTrust(source,trusted).ok,true);
 return {source,draft,patches,trusted};
}
test('fixed-source select bridge survives object-key normalization at a persistence boundary',()=>{
 const {source,trusted}=selectStages();
 assert.equal(checkTrust(reorder(source),reorder(trusted)).ok,true);
 assert.equal(checkTrust(source,reorder(trusted)).ok,true);
 assert.equal(checkTrust(reorder(source),trusted).ok,true);
});
test('public patch proof survives independently normalized source and candidate keys',()=>{
 const {source,draft,patches}=selectStages();
 const result=applyEvidenceBackedPatches(reorder(draft),reorder(patches),{sourceDraft:reorder(source),sourceRefs:collectSourceRefs(source)});
 assert.equal(result.ok,true);
});
test('object-key normalization preserves strict native-effect and option-array comparisons',()=>{
 for(const change of [
  dsl=>{dsl.formRules.linkage[0].effects[0].type='unproven_change';},
  dsl=>{dsl.form.fields.find(field=>field.id==='fd_choice').props.options.reverse();},
  dsl=>{dsl.scripts.actions[0].coverage.nativeRules.push('unproven.rule');}
 ]){
  const {source,trusted}=selectStages(),candidate=reorder(trusted);change(candidate);
  const result=checkTrust(reorder(source),candidate);assert.equal(result.ok,false);
  assert.ok(result.diagnostics.some(item=>item.code==='trust.script_select_empty_source_mismatch'));
 }
});
test('numeric width evidence compares object values independently of width-key order',()=>{
 const source=cleanSourceFile('tests/fixtures/route-validation/numeric-editor-width/numeric-editor-width_SysFormTemplate.xml');
 const draft=draftSourceDraft(source),expected=[...sourceNumberEditors(draft.form).keys()];assert.ok(expected.includes('fd_amount'));
 const item=draft.form.layout.mkTree.flatMap(row=>row.children||[]).flatMap(cell=>cell.contentFlow?.items||[]).find(item=>item.referenceId==='fd_amount');
 item.width=Object.fromEntries(Object.entries(item.width).reverse());
 assert.deepEqual([...sourceNumberEditors(draft.form).keys()],expected);
 item.width.value+=1;assert.equal(sourceNumberEditors(draft.form).has('fd_amount'),false);
});
