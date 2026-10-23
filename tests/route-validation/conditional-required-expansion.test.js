import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {cleanSourceFile, draftSourceDraft} from '../../src/translator/index.js';
import {prepareSample, formAttr, xformConfig} from '../helpers/persistence.js';
import {nativeRequiredRuntime} from '../helpers/native-required-runtime.js';

const fixture = 'tests/fixtures/route-validation/required-permissions/route-required-permissions_SysFormTemplate.xml';
const fn = `function onChange(value) {
  if (value === 'YES') {
    MKXFORM.setFieldAttr('rows_row', 5);
    MKXFORM.setFieldAttr('rows_row', 3);
    MKXFORM.setFieldAttr('intro_row', 5);
    MKXFORM.setFieldAttr('intro_row', 3);
  } else {
    MKXFORM.setFieldAttr('rows_row', 4);
    MKXFORM.setFieldAttr('rows_row', 6);
    MKXFORM.setFieldAttr('intro_row', 4);
    MKXFORM.setFieldAttr('intro_row', 6);
  }
}`;

function prepare(functionText = fn) {
  const dsl = draftSourceDraft(cleanSourceFile(fixture));
  dsl.scripts = {actions:[{
    id:'seal-condition', event:'onChange', scope:'control', controlId:'fd_seal',
    function:functionText, translationStatus:'mapped'
  }]};
  const prepared = prepareSample(dsl);
  const config = xformConfig(prepared.update);
  const table = config.dataModel.find(model => model.fdType === 'detail').fdTableName;
  const main = config.dataModel.find(model => model.fdType === 'main').fdTableName;
  const action = formAttr(prepared.update).controlAction.control[`${main}.fd_seal`].onChange[0];
  const runtime = nativeRequiredRuntime(config);
  const execute = new Function('MKXFORM', `return (${action.function});`)(runtime.MKXFORM);
  return {prepared, config, table, action, runtime, execute};
}

describe('conditional required row expansion route', () => {
  it('restores required detail columns without forcing optional main/detail fields or unlocking readonly columns', () => {
    const {prepared, table, runtime, execute} = prepare();
    for (const value of ['NO', 'YES', 'NO', 'YES']) {
      execute(value);
      const active = value === 'YES';
      assert.equal(runtime.detailRequired(table, 'fd_document'), active);
      assert.equal(runtime.detailRequired(table, 'fd_note'), false);
      assert.equal(runtime.detailRequired(table, 'fd_code'), active);
      assert.equal(runtime.detailColumn(table, 'fd_code').controlProps.showStatus, 'readOnly');
      assert.equal(runtime.required('fd_subject'), active);
      assert.equal(runtime.required('fd_intro_org'), false);
      assert.equal(runtime.field(table).labelProps.hidden, !active);
    }
    assert.equal(prepared.verify(prepared.update).ok, true);
  });

  it('retains explicit field-level force-required semantics', () => {
    const {runtime, execute} = prepare(`function onChange() {
      MKXFORM.setFieldAttr('fd_intro_org', 3);
    }`);
    execute();
    assert.equal(runtime.required('fd_intro_org'), true);
  });

  it('evaluates a dynamic row attribute once and handles both display and required attributes', () => {
    const {runtime, table, execute} = prepare(`function onChange(value) {
      var calls = 0;
      function next() { calls++; return value; }
      MKXFORM.setFieldAttr('rows_row', next());
      return calls;
    }`);
    assert.equal(execute(6), 1);
    assert.equal(runtime.detailRequired(table, 'fd_document'), false);
    assert.equal(execute(3), 1);
    assert.equal(runtime.detailRequired(table, 'fd_document'), true);
    assert.equal(runtime.detailRequired(table, 'fd_note'), false);
    assert.equal(execute(4), 1);
    assert.equal(runtime.field(table).labelProps.hidden, true);
    assert.equal(execute(5), 1);
    assert.equal(runtime.field(table).labelProps.hidden, false);
  });

  it('keeps an unbraced conditional row update conditional', () => {
    const {runtime, table, execute} = prepare(`function onChange(value) {
      if (value) MKXFORM.setFieldAttr('rows_row', 6);
    }`);
    execute(false);
    assert.equal(runtime.detailRequired(table, 'fd_document'), true);
    execute(true);
    assert.equal(runtime.detailRequired(table, 'fd_document'), false);
  });

  it('projects row required form rules to individual main/detail fields with their own baseline flags', () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    dsl.formRules = {linkage:[{
      id:'seal-required', trigger:'change', source:'fd_seal', logic:'and',
      when:[{field:'fd_seal', op:'eq', value:'YES'}],
      effects:[{type:'required', target:'rows_row', value:true}, {type:'required', target:'intro_row', value:true}],
      else:[{type:'required', target:'rows_row', value:false}, {type:'required', target:'intro_row', value:false}],
      translationStatus:'executable'
    }]};
    const prepared = prepareSample(dsl);
    const config = xformConfig(prepared.update);
    const table = config.dataModel.find(model => model.fdType === 'detail').fdTableName;
    const when = formAttr(prepared.update).formRule.require.find(rule => rule.meta.branch === 'when');
    assert.deepEqual(when.result.map(result => [result.fieldName, result.tableType, result.type, result.required]).sort(), [
      ['fd_document','detail',table,'required'],
      ['fd_note','detail',table,'non-required'],
      ['fd_code','detail',table,'required'],
      ['fd_subject','main','main','required'],
      ['fd_intro_org','main','main','non-required']
    ].sort());
    assert.equal(prepared.verify(prepared.update).ok, true);
    const changed = structuredClone(prepared.update);
    const changedConfig = xformConfig(changed);
    const changedAttr = JSON.parse(changedConfig.attribute.formAttr);
    const required = changedAttr.formRule.require.find(rule => rule.meta.branch === 'when');
    required.result = required.result.filter(result => result.fieldName !== 'fd_document');
    changedConfig.attribute.formAttr = JSON.stringify(changedAttr);
    changed.mechanisms['sys-xform'].fdConfig = JSON.stringify(changedConfig);
    assert.equal(prepared.verify(changed).ok, false);
  });
});
