import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanSourceFile, draftSourceDraft } from '../../src/translator/index.js';
import { checkTrust, createTrustedMigrationDsl } from '../../src/dsl/trust.js';
import { prepareSample, xformConfig } from '../helpers/persistence.js';
import { readFileSync } from 'node:fs';
import { parseRootHashMapStringPuts } from '../../src/translator/xml-utils.js';
import { translateSysFormTemplateXml } from '../../src/translator/sysform-template-adapter.js';
import { sourceDraftFromLegacyDsl } from '../../src/translator/source-draft.js';
const path = 'tests/fixtures/route-validation/redundant-address-companion/route-it-procurement_SysFormTemplate.xml';
const nameId = 'fd_use_dept.name';
const addressId = 'fd_use_dept';

describe('redundant address name column', () => {
  it('retains the real travel companion referenced only by a runtime button handler', () => {
    const props = parseRootHashMapStringPuts(readFileSync('tests/fixtures/route-validation/travel-applicant-input/route-travel-applicant_SysFormTemplate.xml', 'utf8'));
    const id = 'fd_3293e0c29f78ac.name';
    props.fdDisplayJsp += `<BUTTON onclick="document.getElementById('${id}').value='x'">X</BUTTON>`;
    const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const xml = '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${escape(value)}</string></void>`).join('') + '</object></java>';
    const source = sourceDraftFromLegacyDsl(translateSysFormTemplateXml(xml));
    assert.ok(source.form.controls.some(f => f.sourceProps?.staticCaptionFact?.domContext.inlineScripts.some(s => s.includes(id))));
    assert.ok(!JSON.stringify(source.scripts).includes(id));
    assert.ok(draftSourceDraft(source).form.fields.some(f => (f.sourceProps?.originalId || f.id) === id));
  });

  it('does not treat observational caption scope as a value dependency', () => {
    const source = cleanSourceFile(path);
    const caption = source.form.controls.find(f => f.sourceProps?.designerType === 'textLabel');
    assert.ok(caption);
    caption.sourceProps.staticCaptionFact = { ...caption.sourceProps.staticCaptionFact,
      domContext: { version: 1, ancestorIds: [nameId], cellDescendantIds: [nameId], inlineScripts: [] } };
    assert.ok(!draftSourceDraft(source).form.fields.some(f => (f.sourceProps?.originalId || f.id) === nameId));
    caption.sourceProps.configuredDependency = nameId;
    assert.ok(draftSourceDraft(source).form.fields.some(f => (f.sourceProps?.originalId || f.id) === nameId));
  });

  for (const kind of ['runtime-only script', 'incomplete runtime attributes']) it(`retains a companion with ${kind}`, () => {
    const source = cleanSourceFile(path);
    const caption = source.form.controls.find(f => f.sourceProps?.designerType === 'textLabel');
    caption.sourceProps.staticCaptionFact = { ...caption.sourceProps.staticCaptionFact, domContext: {
      version: 1, ancestorIds: [], cellDescendantIds: [],
      inlineDomainComplete: kind !== 'incomplete runtime attributes',
      inlineScripts: kind === 'runtime-only script' ? [`document.getElementById("${nameId}").value="x";`] : []
    } };
    assert.ok(draftSourceDraft(source).form.fields.some(f => (f.sourceProps?.originalId || f.id) === nameId));
  });

  it('persists only the native address field while retaining the source display width', () => {
    const source = cleanSourceFile(path);
    const draft = draftSourceDraft(source);
    assert.ok(!draft.form.fields.some(f => (f.sourceProps?.originalId || f.id) === nameId));
    const address = draft.form.fields.find(f => f.id === addressId);
    assert.equal(address.sourceProps.consumedAddressDisplayCompanionId, nameId);
    const cell = draft.form.layout.mkTree.flatMap(row => row.children).find(c => c.refIds?.includes(addressId));
    assert.deepEqual(cell.refIds, [addressId]);
    assert.equal(cell.contentFlow.items.find(i => i.referenceId === addressId).width.value, 198);
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
    assert.equal(checkTrust(source, trusted).ok, true, JSON.stringify(checkTrust(source, trusted).diagnostics));
    const p = prepareSample(draft);
    const fields = xformConfig(p.update).dataModel[0].fdFields;
    assert.ok(!fields.some(f => f.fdName === nameId));
    assert.equal(fields.find(f => f.fdName === addressId).fdType, 'address');
    assert.equal(p.verify(p.update).ok, true);
    cell.contentFlow.items[0].width.value = 1;
    const damaged = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
    assert.ok(checkTrust(source, damaged).diagnostics.some(d => d.code === 'trust.form.presentation_content_flow_mismatch'));
  });

  for (const kind of ['script', 'workflow', 'rule', 'default', 'readonly', 'independent-title']) {
    it(`retains a companion with ${kind} semantics`, () => {
      const source = cleanSourceFile(path);
      const input = source.form.controls.find(f => f.id === nameId);
      if (kind === 'script') source.scripts = { evidence: nameId };
      if (kind === 'workflow') source.workflow = { evidence: nameId };
      if (kind === 'rule') source.formRules = { evidence: nameId };
      if (kind === 'default') input.sourceProps.designerValues.defaultValue = '部门';
      if (kind === 'readonly') input.sourceProps.designerValues.readOnly = 'true';
      if (kind === 'independent-title') input.sourceProps.designerValues.label = '申请人1';
      assert.ok(draftSourceDraft(source).form.fields.some(f => (f.sourceProps?.originalId || f.id) === nameId));
    });
  }
});
