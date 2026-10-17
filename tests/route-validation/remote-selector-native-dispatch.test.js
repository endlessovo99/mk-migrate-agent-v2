import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {it} from 'node:test';
const contract=JSON.parse(fs.readFileSync('tests/fixtures/executor/remote-selector-native/contract.json'));
const hash=s=>createHash('sha256').update(s).digest('hex');
it('captured native button dispatcher preserves row and parent-row arguments without executing a source script',()=>{
 assert.equal(hash(contract.buttonCallback),contract.buttonCallbackSha256);assert.equal(hash(contract.dispatcher),contract.dispatcherSha256);
 for(const[row,parent]of [[0,undefined],[3,undefined],[2,4]]){
  const window={},target={},event={fixture:true},actions={onClick:{fixture:'native-handler'}},calls=[];
  vm.runInNewContext(contract.dispatcher,{t:target,window,O:(_obj,key,value)=>({[key]:value}),du(...args){calls.push(args);}});
  const click=vm.runInNewContext('('+contract.buttonCallback+')',{f:{type:'js'},m:actions,r:{actionFunsRunner:target.actionFunsRunner},b:'fixture_button',x:'fixture_rows',w:row,A:parent});
  click(event);const actual=window.MXFORM_ACTIONS.fixture_button;
  assert.deepEqual(Array.from(actual.actionParams.onClick),[event,row,parent]);assert.equal(actual.actionTableName,'fixture_rows');assert.equal(actual.actionTableType,'main');
 }
});
