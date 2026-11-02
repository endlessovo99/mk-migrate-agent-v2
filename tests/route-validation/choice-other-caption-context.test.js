import assert from 'node:assert/strict';
import {it} from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {sourceCaptionBehavior} from '../../src/translator/dsl-draft.js';
import {checkDraft} from '../../src/dsl/checks.js';
const fixture='tests/fixtures/route-validation/choice-other-caption-context/route-other-caption_SysFormTemplate.xml';
it('uses the source-bound same-cell context when checking a separate Other caption',()=>{
  const source=cleanSourceFile(fixture),choice=source.form.controls.find(f=>f.id==='fd_kind'),relation=choice.sourceProps.otherTextCompanion;
  assert.equal(relation.captionId,'fd_other_caption');assert.equal(choice.sourceProps.otherPairContext.inlineDomainComplete,true);
  assert.equal(sourceCaptionBehavior(source).forPair(choice.id,relation.captionId,choice.sourceProps.otherPairContext).ok,true);
  const draft=draftSourceDraft(source);assert.equal(draft.form.fields.find(f=>f.id==='fd_kind').nativeOther?.version,1);
  assert.equal(checkDraft(draft).diagnostics.some(x=>x.level==='error'&&/native_other/.test(x.code)),false);
});
it('keeps unknown context or scripts affecting the caption blocked',()=>{
  const original=cleanSourceFile(fixture);delete original.form.controls.find(f=>f.id==='fd_kind').sourceProps.otherPairContext;
  assert.equal(draftSourceDraft(original).form.fields.find(f=>f.id==='fd_kind').nativeOther,undefined);
  const dir=mkdtempSync(join(tmpdir(),'caption-context-'));
  try {let text=readFileSync(fixture,'utf8'),changed=text.replace('var flag=1;','document.getElementById("fd_other_caption").innerHTML="changed";var flag=1;');assert.notEqual(changed,text);let f=join(dir,'mutant_SysFormTemplate.xml');writeFileSync(f,changed);assert.equal(draftSourceDraft(cleanSourceFile(f)).form.fields.find(f=>f.id==='fd_kind').nativeOther,undefined);}finally{rmSync(dir,{recursive:true,force:true});}
});

it('requires the same Other caption in the runtime cell before relying on pair context',()=>{
  const dir=mkdtempSync(join(tmpdir(),'caption-runtime-'));
  try {const xml=readFileSync(fixture,'utf8'),marker='&lt;LABEL ID="fd_other_caption"&gt;其他&lt;/LABEL&gt;';
    for (const [i,replacement] of ['', '&lt;LABEL ID="fd_other_caption" style="display:none"&gt;其他&lt;/LABEL&gt;',
      '&lt;LABEL ID="fd_other_caption" onclick="unknown()"&gt;其他&lt;/LABEL&gt;'].entries()) {
      const changed=xml.replace(marker,replacement);assert.notEqual(changed,xml);
      const file=join(dir,`mutant-${i}_SysFormTemplate.xml`);writeFileSync(file,changed);
      assert.equal(draftSourceDraft(cleanSourceFile(file)).form.fields.find(f=>f.id==='fd_kind').nativeOther,undefined);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
