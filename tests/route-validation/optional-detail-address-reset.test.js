import assert from 'node:assert/strict';
import {it} from 'node:test';
import {cleanSourceFile, draftSourceDraft} from '../../src/translator/index.js';
import {prepareSample, formAttr, xformConfig} from '../helpers/persistence.js';
import {nativeRequiredRuntime} from '../helpers/native-required-runtime.js';

const fixture='tests/fixtures/route-validation/optional-detail-address-reset/route-optional-detail-address-reset_SysFormTemplate.xml';
function setup() {
  const dsl=draftSourceDraft(cleanSourceFile(fixture));
  delete dsl.formRules;
  dsl.scripts={actions:[{id:'row-condition',event:'onChange',scope:'control',controlId:'fd_seal',translationStatus:'mapped',
    function:`function onChange(value) {
      if(value === 'YES') { MKXFORM.setFieldAttr('rows_row',5); MKXFORM.setFieldAttr('rows_row',3); }
      else { MKXFORM.setFieldAttr('rows_row',4); MKXFORM.setFieldAttr('rows_row',6); }
      MKXFORM.setFieldAttr('intro_row', value === 'YES' ? 5 : 4);
    }`}]};
  const prepared=prepareSample(dsl), config=xformConfig(prepared.update);
  const main=config.dataModel.find(m=>m.fdType==='main').fdTableName;
  const detail=config.dataModel.find(m=>m.fdType==='detail');
  const action=formAttr(prepared.update).controlAction.control[`${main}.fd_seal`].onChange[0];
  const runtime=nativeRequiredRuntime(config);
  // The actual preview's optional address column retains its persisted options;
  // unlike text controls, it may arrive without an options/validateRules object.
  const address=runtime.detailColumn(detail.fdTableName,'fd_optional_org');
  const attribute=JSON.parse(detail.fdFields.find(f=>f.fdName==='fd_optional_org').fdAttribute);
  if(attribute.config.options === undefined) delete address.options;
  else address.options=structuredClone(attribute.config.options);
  const execute=new Function('MKXFORM',`return (${action.function});`)(runtime.MKXFORM);
  return {dsl,prepared,config,detail,runtime,execute};
}

it('continues row visibility and preserves required columns when the native optional address reset has no validator',()=>{
  const {prepared,detail,runtime,execute}=setup();
  assert.doesNotThrow(()=>execute('NO'));
  assert.equal(runtime.field(detail.fdTableName).labelProps.hidden,true);
  assert.equal(runtime.detailRequired(detail.fdTableName,'fd_optional_org'),false);
  assert.equal(runtime.detailRequired(detail.fdTableName,'fd_document'),false);
  assert.equal(runtime.field('fd_subject').labelProps.hidden,true);
  assert.doesNotThrow(()=>execute('YES'));
  assert.equal(runtime.detailRequired(detail.fdTableName,'fd_optional_org'),false);
  assert.equal(runtime.detailRequired(detail.fdTableName,'fd_document'),true);
  assert.equal(runtime.detailRequired(detail.fdTableName,'fd_code'),true);
  assert.equal(runtime.field('fd_subject').labelProps.hidden,false);
  assert.equal(prepared.verify(prepared.update).ok,true);
});

it('requires the non-required native validator to survive readback for that optional detail selector',()=>{
  const {prepared,detail}=setup();
  const column=detail.fdFields.find(f=>f.fdName==='fd_optional_org');
  const attribute=JSON.parse(column.fdAttribute);
  assert.deepEqual(attribute.config.options?.validateRules,[{required:false}]);
  const corrupt=structuredClone(prepared.update), config=xformConfig(corrupt);
  const field=config.dataModel.find(m=>m.fdType==='detail').fdFields.find(f=>f.fdName==='fd_optional_org');
  const altered=JSON.parse(field.fdAttribute);delete altered.config.options;field.fdAttribute=JSON.stringify(altered);
  corrupt.mechanisms['sys-xform'].fdConfig=JSON.stringify(config);
  assert.equal(prepared.verify(corrupt).ok,false);
});

it('allows the native detail API to set and clear requiredness on the initially optional selector',()=>{
  const {runtime,detail}=setup(), table=detail.fdTableName;
  runtime.MKXFORM.setDetailFieldAttr(`${table}.fd_optional_org`,3);
  assert.equal(runtime.detailRequired(table,'fd_optional_org'),true);
  runtime.MKXFORM.setDetailFieldAttr(`${table}.fd_optional_org`,6);
  assert.equal(runtime.detailRequired(table,'fd_optional_org'),false);
});

it('does not replace required address or unrelated detail control validation',()=>{
  const dsl=draftSourceDraft(cleanSourceFile(fixture));
  const table=dsl.form.fields.find(f=>f.id==='fd_rows');
  table.columns.find(c=>c.id==='fd_optional_org').props.required=true;
  const prepared=prepareSample(dsl), detail=xformConfig(prepared.update).dataModel.find(m=>m.fdType==='detail');
  const attr=id=>JSON.parse(detail.fdFields.find(f=>f.fdName===id).fdAttribute).config;
  assert.equal(attr('fd_optional_org').controlProps.required,true);
  assert.equal(attr('fd_optional_org').options?.validateRules,undefined);
  assert.equal(attr('fd_document').options?.validateRules,undefined);
  assert.equal(prepared.verify(prepared.update).ok,true);
});
