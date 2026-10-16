import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'acorn';
import { cleanSourceFile, draftSourceDraft } from '../../src/translator/index.js';
import { isUnconditionalAttachmentRequirement } from '../../src/translator/attachment-non-empty.js';
import { checkDraft } from '../../src/dsl/checks.js';
import { prepareSample, xformConfig } from '../helpers/persistence.js';
import { runRouteCase } from './run-route-case.js';

const fixture = 'tests/fixtures/route-validation/attachment-identity-else/route-direct-without-else_SysFormTemplate.xml';
const source = () => cleanSourceFile(fixture);
const guard = () => source().scripts.sources.find(item => item.javascript.includes('attachmentObject_fd_attach')).javascript;
const withElse = () => guard().replace('alert("Attachment is required"); }', 'alert("Attachment is required"); } else { valid = true; }');

test('the guard without identity else completes native readback and transfer recording', async () => {
  const result = await runRouteCase('attachment-without-identity-else-success');
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.readback.form.fields.find(field => field.id === 'fd_attach').required, true);
  assert.equal(result.execution.transferRecord.status, 'recorded');
});

test('a complete boolean attachment guard does not need an identity else assignment', () => {
  assert.equal(isUnconditionalAttachmentRequirement(guard(), 'fd_attach'), true);
  assert.equal(isUnconditionalAttachmentRequirement(withElse(), 'fd_attach'), true);
  assert.equal(isUnconditionalAttachmentRequirement(guard().replaceAll('var ', 'let '), 'fd_attach'), true);
});

test('the public XML route retains native required coverage for the guard without identity else', () => {
  const draft = draftSourceDraft(source());
  const field = draft.form.fields.find(item => item.id === 'fd_attach');
  const action = draft.scripts.actions.find(item => item.recipe?.kind === 'attachment_non_empty');
  assert.equal(field.props.required, true);
  assert.equal(action.translationStatus, 'omitted');
  assert.equal(action.function, '');
  assert.deepEqual(action.runWhen, { viewStatusIn: ['add', 'edit'] });
  assert.deepEqual(action.coverage.staticProps, [{ fieldId: 'fd_attach', prop: 'required', value: true }]);
  assert.deepEqual(action.recipe.nativeRequiredEvidence, { contractVersion: 1, sourceShape: 'active-file-submit-guard', displayGate: 'xform:editShow' });
  assert.equal(checkDraft(draft).ok, true);
  const prepared = prepareSample(draft);
  const fields = xformConfig(prepared.update).dataModel[0].fdFields;
  assert.equal(JSON.parse(fields.find(item => item.fdName === 'fd_attach').fdAttribute).config.controlProps.required, true);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

for (const [name, mutate] of [
  ['initial false', text => text.replace('var valid = true', 'var valid = false')],
  ['const validator', text => text.replace('var valid = true', 'const valid = true')],
  ['const counter', text => text.replace('var count = 0', 'const count = 0')],
  ['const index', text => text.replace('var i=0', 'const i=0')],
  ['later true mutation', text => text.replace('return valid;', 'valid = true; return valid;')],
  ['external write', text => text.replace('return valid;', 'window.audit = valid; return valid;')],
  ['early return', text => text.replace('var valid = true;', 'return true; var valid = true;')],
  ['dynamic alert', text => text.replace('alert("Attachment is required")', 'alert(makeMessage())')],
  ['different else', text => replaceFinalBranch(text, 'if (!valid) { alert("Attachment is required"); } else { valid = false; }')],
  ['side-effecting else', text => replaceFinalBranch(text, 'if (!valid) { alert("Attachment is required"); } else { window.audit = true; }')],
  ['false plus else mutations', text => replaceFinalBranch(text, 'if (!valid) { alert("Attachment is required"); } else { valid = true; window.audit = true; }')],
  ['validator and count alias', text => text.replaceAll('count', 'valid')],
  ['counter and index alias', text => text.replaceAll('count', 'i')],
  ['local alert shadow', text => text.replaceAll('valid', 'alert')],
  ['local attachment global shadow', text => text.replaceAll('valid', 'attachmentObject_fd_attach')],
  ['different deletion filter', text => text.replace('fileStatus > -1', 'fileStatus >= -1')],
  ['conditional submit registration', text => 'if (window.condition) {' + text + '}'],
  ['view-only native evidence', null]
]) {
  test(`identity-else proof refuses ${name}`, () => {
    if (mutate) {
      for (const base of [guard(), withElse()]) {
        const candidate = mutate(base);
        assert.doesNotThrow(() => parse(candidate, { ecmaVersion: 'latest' }));
        assert.equal(isUnconditionalAttachmentRequirement(candidate, 'fd_attach'), false);
      }
    }
    else {
      const viewSource = cleanSourceFile('tests/fixtures/route-validation/attachment-identity-else/route-direct-view-only_SysFormTemplate.xml');
      const draft = draftSourceDraft(viewSource);
      const action = draft.scripts.actions.find(item => item.recipe?.kind === 'attachment_non_empty');
      assert.equal(action.translationStatus, 'needs_review');
      assert.notEqual(draft.form.fields.find(item => item.id === 'fd_attach').props.required, true);
    }
  });
}

function replaceFinalBranch(text, replacement) {
  return text.replace(/if \(!valid\) \{ alert\("Attachment is required"\); \}(?: else \{ valid = true; \})?/, replacement);
}
