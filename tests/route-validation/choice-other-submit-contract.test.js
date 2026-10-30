import assert from "node:assert/strict";
import { it } from "node:test";
import { runInNewContext } from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { withChoiceOtherRuntime } from "../../src/dsl/choice-other-runtime.js";
import { withChoiceOtherStorageRuntime } from "../../src/dsl/choice-other-storage-runtime.js";
import { CHOICE_OTHER_STORAGE_CAPABILITY } from "../../src/dsl/choice-other-storage-capability.js";

const fixture = "tests/fixtures/route-validation/checkbox-other-compatible/compatible_SysFormTemplate.xml";
const table = "mk_main_test";

function runtime(initial) {
  const form = draftSourceDraft(cleanSourceFile(fixture)).form;
  const projected = withChoiceOtherStorageRuntime(withChoiceOtherRuntime({ actions: [] }, form, table), form, table);
  const values = structuredClone(initial), writes = [], subscriptions = [], beforeSubmit = [];
  let nativeGetter = () => Object.fromEntries(Object.entries(values).map(([k,v]) => [`${table}.${k}`, v]));
  const nativeForm = {};
  Object.defineProperty(nativeForm, "getFieldsValue", { configurable: true, enumerable: true,
    get() { return nativeGetter; }, set(value) { nativeGetter = value; } });
  const sdk = { MKXFORM_DATA_CONTAINER: {}, $$FORM: { current: nativeForm },
    getValue(ref) { return values[ref.slice(table.length + 1)]; },
    setValue(ref, value) { const id=ref.slice(table.length+1);writes.push({id,value:structuredClone(value)});values[id]=structuredClone(value); },
    onChange(ref, callback) { subscriptions.push({ref,callback}); },
    beforeSubmit(callback, message) { beforeSubmit.push({callback,message}); }
  };
  const cap=CHOICE_OTHER_STORAGE_CAPABILITY,asset=`${cap.origin}/web/${cap.modules.desktop.path}/index.js?${cap.modules.desktop.release}`;
  const location={origin:cap.origin},document={scripts:[{src:asset}]};
  let stack = `at Object.getFlatValue (${asset}:1:1)`;
  function BrowserError() { this.stack = stack; }
  const actions = projected.actions.filter(action => action.event === "onLoad");
  const initialize = () => actions.forEach(action => runInNewContext(`(${action.function})`, { MKXFORM: sdk, Error: BrowserError, location, document })({}));
  const read = caller => { stack = `at Object.${caller} (${asset}:1:1)`;return nativeForm.getFieldsValue(); };
  const readFrom = (caller,url) => { stack = `at Object.${caller} (${url}:1:1)`;return nativeForm.getFieldsValue(); };
  return { form, projected, values, sdk, nativeForm, writes, subscriptions, beforeSubmit, initialize, read, readFrom, document, location,
    replaceNativeGetter(next) { nativeForm.getFieldsValue = next; } };
}

it("preserves checkbox arrays for flow calculation but sends proven strings at the native submission boundary", () => {
  const r=runtime({ fd_choice:["A","B"], fd_plain:["P"], fd_other_text:"说明", fd_other_caption:[] });
  r.initialize();
  assert.equal(r.beforeSubmit[0].callback({isDraft:false}),true);
  const flow=r.read("getFlatValue"), submit=r.read("getXformValue");
  assert.deepEqual(flow[`${table}.fd_choice`],["A","B"]);
  assert.deepEqual(flow[`${table}.fd_other_caption`],[]);
  assert.equal(submit[`${table}.fd_choice`],"A,B");
  assert.equal(submit[`${table}.fd_plain`],"P");
  assert.equal(submit[`${table}.fd_other_caption`],"0");
  assert.deepEqual(r.values.fd_choice,["A","B"]);
  assert.deepEqual(r.values.fd_other_caption,[]);
  assert.equal(r.values.fd_other_text,"说明");
});

it("restores the independent Other state and original choices from saved strings", () => {
  for(const [saved,note,expected] of [["selected","",["selected"]],["0","保留的说明",[]],[undefined,"原说明",["selected"]]]) {
    const r=runtime({fd_choice:"A,B",fd_plain:"P",fd_other_text:note,fd_other_caption:saved});r.initialize();
    assert.deepEqual(r.values.fd_choice,["A","B"]);
    assert.deepEqual(r.values.fd_plain,["P"]);
    assert.deepEqual(r.values.fd_other_caption,expected);
    assert.equal(r.values.fd_other_text,note);
  }
});

it("preserves the bridge when native code replaces its getter and leaves unrelated callers untouched", () => {
  const r=runtime({fd_choice:["A","B"],fd_plain:[],fd_other_text:"",fd_other_caption:["selected"]});r.initialize();
  assert.equal(r.beforeSubmit[0].callback({isDraft:false}),true);
  r.replaceNativeGetter(() => ({[`${table}.fd_choice`]:r.values.fd_choice,[`${table}.fd_other_caption`]:r.values.fd_other_caption}));
  assert.deepEqual(r.read("getFlatValue")[`${table}.fd_choice`],["A","B"]);
  assert.equal(r.read("getXformValue")[`${table}.fd_choice`],"A,B");
  assert.equal(r.read("getXformValue")[`${table}.fd_other_caption`],"selected");
  assert.equal(r.beforeSubmit.length,1);
  assert.equal(r.beforeSubmit[0].callback({isDraft:false}),true);
});

it("does not guess a lossy encoding for ambiguous option values", () => {
  const form=draftSourceDraft(cleanSourceFile(fixture)).form;
  form.fields.find(field=>field.id==="fd_choice").props.options[0].value="ambiguous,code";
  assert.throws(()=>withChoiceOtherStorageRuntime(withChoiceOtherRuntime({actions:[]},form,table),form,table),{code:"projection.choice_other.checkbox_storage_unproven"});
});

it("does not discard an explicit empty selection when a source checkbox has a nonempty default", () => {
  const form=draftSourceDraft(cleanSourceFile(fixture)).form;
  form.fields.find(field=>field.id==="fd_choice").props.defaultValue={kind:"literal",value:["A"]};
  assert.throws(()=>withChoiceOtherStorageRuntime(withChoiceOtherRuntime({actions:[]},form,table),form,table),{code:"projection.choice_other.checkbox_storage_unproven"});
});

it("blocks submission when the actual runtime release is not verified", () => {
  const r=runtime({fd_choice:["A"],fd_other_text:"",fd_other_caption:[]});
  r.document.scripts[0].src=r.document.scripts[0].src.replace(CHOICE_OTHER_STORAGE_CAPABILITY.modules.desktop.release,"0".repeat(32));
  r.initialize();
  assert.equal(r.beforeSubmit.length,1);
  assert.equal(r.beforeSubmit[0].callback({isDraft:false}),false);
  assert.deepEqual(r.values.fd_choice,["A"]);
});

it("reinstalls the bridge after a native rerender and blocks if the accessor cannot be protected", () => {
  const r=runtime({fd_choice:["A","B"],fd_other_text:"",fd_other_caption:[]});r.initialize();
  assert.equal(r.beforeSubmit[0].callback({isDraft:false}),true);
  let native=()=>({[`${table}.fd_choice`]:r.values.fd_choice,[`${table}.fd_other_caption`]:r.values.fd_other_caption});
  Object.defineProperty(r.nativeForm,"getFieldsValue",{configurable:true,get(){return native;},set(value){native=value;}});
  assert.equal(r.beforeSubmit[0].callback({isDraft:false}),true);
  assert.equal(r.read("getXformValue")[`${table}.fd_choice`],"A,B");
  Object.defineProperty(r.nativeForm,"getFieldsValue",{configurable:false,value:native});
  assert.equal(r.beforeSubmit[0].callback({isDraft:false}),false);
});

it("does not transform other callers or invent values for unrecognized stored codes", () => {
  const r=runtime({fd_choice:"unknown",fd_plain:"P",fd_other_text:"",fd_other_caption:"0"});r.initialize();
  assert.equal(r.values.fd_choice,"unknown");assert.deepEqual(r.values.fd_other_caption,[]);
  r.values.fd_choice=["A","unknown"];assert.equal(r.beforeSubmit[0].callback({isDraft:false}),true);
  assert.deepEqual(r.read("getXformValue")[`${table}.fd_choice`],["A","unknown"]);
  r.values.fd_choice=["A","B"];
  assert.deepEqual(r.readFrom("getXformValue","https://example.invalid/web/sys-xform/desktop/api/XFormRuntimeFRagment/index.js")[`${table}.fd_choice`],["A","B"]);
});
