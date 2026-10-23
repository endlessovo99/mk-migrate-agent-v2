import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {cleanSourceFile, draftSourceDraft} from '../../src/translator/index.js';
import {prepareSample, xformConfig} from '../helpers/persistence.js';
import {nativeRequiredRuntime} from '../helpers/native-required-runtime.js';

const fixture = 'tests/fixtures/route-validation/required-permissions/route-required-permissions_SysFormTemplate.xml';
const draft = () => draftSourceDraft(cleanSourceFile(fixture));

describe('required permissions route', () => {
  it('enforces each main/detail field required flag through the native add/edit permission runtime', () => {
    const dsl = draft();
    const prepared = prepareSample(dsl);
    const config = xformConfig(prepared.update);
    const main = config.dataModel.find(model => model.fdType === 'main');
    const detail = config.dataModel.find(model => model.fdType === 'detail');
    const columns = dsl.form.fields.find(field => field.id === 'fd_rows').columns;
    assert.equal(columns.find(field => field.id === 'fd_document').props.required, true);
    assert.equal(columns.find(field => field.id === 'fd_note').props.required, false);
    assert.equal(columns.find(field => field.id === 'fd_code').props.readOnly, true);
    for (const scene of ['add', 'edit']) {
      const permissions = config.auth[0][scene];
      assert.equal(permissions[main.fdTableName].fields.fd_subject.required, true);
      assert.equal(permissions[detail.fdTableName].fields.fd_document.required, true);
      assert.equal(permissions[detail.fdTableName].fields.fd_note.required, false);
      assert.equal(permissions[detail.fdTableName].fields.fd_code.required, true);
      const runtime = nativeRequiredRuntime(config, scene);
      assert.equal(runtime.required(`${detail.fdTableName}.fd_document`), true);
      assert.equal(runtime.required(`${detail.fdTableName}.fd_note`), false);
      assert.equal(runtime.field(`${detail.fdTableName}.fd_code`).controlProps.showStatus, 'readOnly');
    }
    assert.equal(prepared.verify(prepared.update).ok, true);
  });

  for (const scene of ['add', 'edit']) {
    for (const mutation of ['false', 'missing', 'wrong-type', 'disabled', 'conflicting']) {
      it(`rejects ${mutation} native ${scene} permission for a required detail column`, () => {
        const prepared = prepareSample(draft());
        const target = structuredClone(prepared.update);
        const config = xformConfig(target);
        const table = config.dataModel.find(model => model.fdType === 'detail').fdTableName;
        const field = config.auth[0][scene][table].fields.fd_document;
        if (mutation === 'false') field.required = false;
        if (mutation === 'missing') delete field.required;
        if (mutation === 'wrong-type') field.required = 'true';
        if (mutation === 'disabled') config.auth[0].fdIsAvailable = false;
        if (mutation === 'conflicting') {
          const second = structuredClone(config.auth[0]);
          second[scene][table].fields.fd_document.required = false;
          config.auth.push(second);
        }
        target.mechanisms['sys-xform'].fdConfig = JSON.stringify(config);
        const result = prepared.verify(target);
        assert.equal(result.ok, false);
        assert.ok(result.diagnostics.some(item =>
          item.code === 'readback.form.prop_nativeRequiredPermissions_mismatch' &&
          item.details?.columnId === 'fd_document'));
      });
    }
  }

  it('rejects an optional column changed to required even when the control attribute is still optional', () => {
    const prepared = prepareSample(draft());
    const target = structuredClone(prepared.update);
    const config = xformConfig(target);
    const table = config.dataModel.find(model => model.fdType === 'detail').fdTableName;
    config.auth[0].add[table].fields.fd_note.required = true;
    target.mechanisms['sys-xform'].fdConfig = JSON.stringify(config);
    const result = prepared.verify(target);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.details?.columnId === 'fd_note'));
  });
});
