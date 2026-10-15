import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanSourceFile, draftSourceDraft } from '../../src/translator/index.js';
import { prepareSample, xformConfig } from '../helpers/persistence.js';
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
  it('projects only desktop native decoration budget and verifies actual persisted state', () => {
    const {dsl}=stages(), prepared=prepareSample(dsl), config=xformConfig(prepared.update), view=viewOf(prepared.update);
    for(const [id,width] of [['fd_amount',120],['fd_count',50]]) {
      assert.equal(parentOf(view.view.render.desktop[0],id).controlProps.style.width,`${width+32}px`);
      assert.equal(parentOf(view.view.render.mobile[0],id).controlProps.style.width,`${width}px`);
      const field=nativeField(config,id), props=JSON.parse(field.fdAttribute).config.controlProps, font=JSON.parse(field.fdFontExtendData);
      assert.equal(props.showCount,false);assert.equal(font.showCount,false);
      assert.equal(props.numberFormat.unit,'');assert.equal(font.unit,'');assert.equal(props.valueType.precision,0);
    }
    assert.equal(prepared.verify(prepared.update).ok,true);
  });
});
