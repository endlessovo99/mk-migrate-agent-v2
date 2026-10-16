import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanSourceFile, draftSourceDraft } from '../../src/translator/index.js';
import { prepareSample, xformConfig } from '../helpers/persistence.js';
import { checkTrust, createTrustedMigrationDsl } from '../../src/dsl/trust.js';
import { sourceNumberEditors } from '../../src/dsl/source-number-editor.js';
import { runRouteCase } from './run-route-case.js';
import { prepareRequiredTemplateTheme } from '../../src/executor/template-theme.js';
const fixture = 'tests/fixtures/route-validation/numeric-editor-width/numeric-editor-width_SysFormTemplate.xml';
const stages = () => { const source = cleanSourceFile(fixture); return { source, dsl: draftSourceDraft(source) }; };
function parentOf(value, key) {
  if (!value || typeof value !== 'object') return;
  if (value.children?.some(child => child.key === key)) return value;
  return (value.children || []).map(child => parentOf(child, key)).find(Boolean);
}
const viewOf = update => JSON.parse(xformConfig(update).viewModel[0].fdConfig);
const nativeField = (config, id) => config.dataModel.flatMap(model => model.fdFields || []).find(field => field.fdName === id);
describe('source numeric text editor budget', () => {
  it('keeps external units and source widths through clean and draft', () => {
    const {source,dsl}=stages();
    assert.ok(dsl.form.fields.some(f=>f.id==='fd_count_unit'));
    assert.equal(dsl.form.fields.find(f=>f.id==='fd_count').props.unit,undefined);
    assert.deepEqual(dsl.form.layout.mkTree[1].children[1].contentFlow,source.form.layout.rows[1].cells[1].contentFlow);
  });
  it('projects native shell budgets and mobile input minima and verifies persisted state', () => {
    const {dsl}=stages(), prepared=prepareSample(dsl), config=xformConfig(prepared.update), view=viewOf(prepared.update);
    for(const [id,width] of [['fd_amount',120],['fd_count',50]]) {
      assert.equal(parentOf(view.view.render.desktop[0],id).controlProps.style.width,`${width+32}px`);
      assert.equal(parentOf(view.view.render.mobile[0],id).controlProps.style.width,`${Math.max(80,width)+32}px`);
      const field=nativeField(config,id), props=JSON.parse(field.fdAttribute).config.controlProps, font=JSON.parse(field.fdFontExtendData);
      assert.equal(props.showCount,false);assert.equal(font.showCount,false);
      assert.equal(props.numberFormat.unit,'');assert.equal(font.unit,'');assert.equal(props.valueType.precision,0);
    }
    assert.equal(prepared.verify(prepared.update).ok,true);
  });

  it('uses the inner width once for required controls and preserves decimal semantics', () => {
    const {dsl}=stages(), prepared=prepareSample(dsl), config=xformConfig(prepared.update), view=viewOf(prepared.update);
    for(const [id,input,outer,precision] of [['fd_required_count',50,56,0],['fd_required_amount',120,126,0],['fd_decimal',50,50,2],['fd_peer',50,50,0]]) {
      assert.equal(parentOf(view.view.render.desktop[0],id).controlProps.style.width,`${input+32}px`);
      assert.equal(parentOf(view.view.render.mobile[0],id).controlProps.style.width,`${Math.max(80,input)+32}px`);
      assert.equal(JSON.parse(nativeField(config,id).fdAttribute).config.controlProps.valueType.precision,precision);
    }
    assert.equal(prepared.verify(prepared.update).ok,true);
  });

  it('keeps incomplete numeric unit groups on their existing range presentation', () => {
    const source=cleanSourceFile('tests/fixtures/route-validation/staff-demand-title/route-staff-demand_SysFormTemplate.xml');
    const dsl=draftSourceDraft(source), profiles=sourceNumberEditors(dsl.form);
    for(const id of ['fd_3294ae3d897c30','fd_3294ae40b7c302']) assert.equal(profiles.has(id),false);
    assert.equal(dsl.form.fields.find(f=>f.id==='fd_3294ae3d897c30').props.unit,'到');
  });

  for(const [name,alter] of [
    ['native number',f=>{f.sourceProps.designerType='number';}],
    ['missing source width',f=>{delete f.sourceProps.designerValues.width;}],
    ['percentage source width',f=>{f.sourceProps.designerValues.width='50%';}],
    ['readonly source',f=>{f.sourceProps.designerValues.readOnly='true';}],
    ['data only',f=>{f.dataOnly=true;}],
    ['unknown prefix',f=>{f.sourceProps.designerValues.prefix='unknown';}],
    ['unknown suffix',f=>{f.sourceProps.designerValues.suffix='unknown';}]
  ]) it(`does not extend editor policy to ${name}`,()=>{
    const {source}=stages(), field=source.form.controls.find(f=>f.id==='fd_amount');alter(field);
    assert.equal(sourceNumberEditors(source.form).has(field.id),false);
  });

  it('does not promote detail columns into the main numeric editor policy',()=>{
    const {source,dsl}=stages();
    const sourceIndex=source.form.controls.findIndex(f=>f.id==='fd_amount');
    const [sourceField]=source.form.controls.splice(sourceIndex,1);
    source.form.detailTables.push({id:'fd_numbers',columns:[sourceField]});
    const targetIndex=dsl.form.fields.findIndex(f=>f.id==='fd_amount');
    const [targetField]=dsl.form.fields.splice(targetIndex,1);
    dsl.form.fields.push({id:'fd_numbers',type:'detailTable',columns:[targetField]});
    assert.equal(sourceNumberEditors(source.form).has('fd_amount'),false);
    assert.equal(sourceNumberEditors(dsl.form).has('fd_amount'),false);
  });

  for(const [name,alter] of [
    ['removed source metadata',d=>{d.form.fields.find(f=>f.id==='fd_count').sourceProps={};}],
    ['changed source width',d=>{d.form.fields.find(f=>f.id==='fd_count').sourceProps.designerValues.width='100';}],
    ['changed precision',d=>{d.form.fields.find(f=>f.id==='fd_count').props.precision=2;}],
    ['removed required restriction',d=>{delete d.form.fields.find(f=>f.id==='fd_required_count').props.required;}],
    ['removed external unit',d=>{d.form.fields=d.form.fields.filter(f=>f.id!=='fd_count_unit');}],
    ['changed external unit',d=>{d.form.fields.find(f=>f.id==='fd_count_unit').props.content='件';}],
    ['changed flow width',d=>{d.form.layout.mkTree[1].children[1].contentFlow.items[0].width.value=100;}]
  ]) it(`rejects trusted editor policy with ${name}`,()=>{
    const {source,dsl}=stages();
    const baseline=createTrustedMigrationDsl(source,dsl,{externalAgentReviewed:true});
    assert.equal(checkTrust(source,baseline).ok,true);
    alter(baseline);const checked=checkTrust(source,baseline);
    assert.equal(checked.ok,false);
    assert.ok(checked.diagnostics.some(item=>item.code==='trust.form.number_editor_source_mismatch'));
  });

  const nativeMutations=[
    ['attribute stepper',(_c,_v,attr)=>{attr.config.controlProps.showCount=true;}],
    ['font stepper',(_c,_v,_attr,font)=>{font.showCount=true;}],
    ['attribute unit',(_c,_v,attr)=>{attr.config.controlProps.numberFormat.unit='wrong';}],
    ['font unit',(_c,_v,_attr,font)=>{font.unit='wrong';}],
    ['attribute precision',(_c,_v,attr)=>{attr.config.controlProps.valueType.precision=2;}],
    ['font precision',(_c,_v,_attr,font)=>{font.precision='2';}],
    ['table type',(_c,_v,attr)=>{attr.config.controlProps.$$tableType='detail';}],
    ['attribute suffix',(_c,_v,attr)=>{attr.config.controlProps.suffix='unknown';}],
    ['desktop theme',(_c,v)=>{v.controlStyle.fd_count.desktop.desktopTheme='other';}],
    ['desktop padding mode',(_c,v)=>{v.controlStyle.fd_count.desktop.desktopPaddingMode='compact';}],
    ['desktop layout',(_c,v)=>{v.controlStyle.fd_count.desktop.layout='vertical';}],
    ['desktop padding override',(_c,v)=>{v.controlStyle.fd_count.desktop.paddingControl={left:'0px',right:'0px'};}],
    ['desktop value style override',(_c,v)=>{v.controlStyle.fd_count.desktop.controlValueStyle={padding:'40px'};}],
    ['desktop width',(_c,v)=>{parentOf(v.view.render.desktop[0],'fd_count').controlProps.style.width='50px';}],
    ['mobile width',(_c,v)=>{parentOf(v.view.render.mobile[0],'fd_count').controlProps.style.width='82px';}]
  ];
  for(const [name,alter] of nativeMutations) it(`rejects persisted ${name} drift`,()=>{
    const prepared=prepareSample(stages().dsl), update=structuredClone(prepared.update), config=xformConfig(update);
    const native=nativeField(config,'fd_count'),attr=JSON.parse(native.fdAttribute),font=JSON.parse(native.fdFontExtendData),view=JSON.parse(config.viewModel[0].fdConfig);
    alter(config,view,attr,font);native.fdAttribute=JSON.stringify(attr);native.fdFontExtendData=JSON.stringify(font);config.viewModel[0].fdConfig=JSON.stringify(view);
    update.mechanisms['sys-xform'].fdConfig=JSON.stringify(config);
    assert.equal(prepared.verify(update).ok,false);
  });

  it('accepts exact required theme defaults while retaining unknown style and theme differences',()=>{
    const prepared=prepareSample(stages().dsl), themed=prepareRequiredTemplateTheme(prepared.update).update;
    assert.equal(prepared.verify(themed).ok,true);
    for(const alter of [
      view=>{view.controlStyle.fd_count.desktop.controlValueStyle.fontSize=28;},
      view=>{view.controlStyle.fd_count.desktop.controlValueStyle.marginLeft='-16px';},
      view=>{view.controlStyle.fd_count.mobile.layout='horizontal';},
      view=>{view.theme.desktop.name='other';},
      view=>{view.controlStyle.fd_count.desktop.unknownStyle={};}
    ]) {
      const changed=structuredClone(themed),config=xformConfig(changed),view=JSON.parse(config.viewModel[0].fdConfig);
      alter(view);config.viewModel[0].fdConfig=JSON.stringify(view);changed.mechanisms['sys-xform'].fdConfig=JSON.stringify(config);
      assert.equal(prepared.verify(changed).ok,false);
    }
  });

  it('retains reviewed fake execution and transfer record with the required theme',async()=>{
    const result=await runRouteCase('numeric-editor-width-success');
    assert.equal(result.execution.status,'written');assert.equal(result.execution.readback.ok,true);
    assert.equal(result.execution.transferRecord.status,'recorded');
  });
});
