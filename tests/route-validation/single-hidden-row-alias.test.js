import assert from 'node:assert/strict';import {it} from 'node:test';import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
const file='tests/fixtures/route-validation/single-hidden-row-alias/route-single-row-alias_SysFormTemplate.xml';
it('maps a single hidden-value callback through its canonical physical row',()=>{
 const source=cleanSourceFile(file),draft=draftSourceDraft(source),action=draft.scripts.actions.find(a=>a.event==='onChange');
 assert.equal(action?.translationStatus,'mapped');assert.match(action.function,/setFieldAttr\("fd_primary_row"/);assert.doesNotMatch(action.function,/setFieldAttr\("fd_alias_row"/);
});
