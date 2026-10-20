import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { draftSourceDraft } from "../../src/translator/index.js";
// These width assertions cover retained SourceDrafts and their standalone native caption layouts.
import { cleanSourceWithoutCaptionFact as cleanSourceFile } from "../helpers/retained-caption-source.js";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { runtimePlainCaptionEvidence } from "../../src/translator/runtime-caption-width.js";
import { sourceMobileCaptionGrids } from "../../src/dsl/source-mobile-caption-grid.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const file="tests/fixtures/route-validation/mobile-caption-trailing-break/caption-trailing-break_SysFormTemplate.xml";
const source=()=>cleanSourceFile(file), draft=()=>draftSourceDraft(source());
const template=()=>parseSysFormTemplateXml(readFileSync(file,"utf8"));
const evidence=(d,r)=>runtimePlainCaptionEvidence(d,r).has("caption_phone");
const viewOf=t=>JSON.parse(xformConfig(t).viewModel[0].fdConfig);
const grid=(v,scene)=>v.view.render[scene][0].children[0].children[0].children[0];

it("retains the authored terminal CRLF and BR while proving both static widthless caption ends",()=>{
  const s=source(),d=draft(),t=template(),caption=d.form.fields.find(f=>f.id==="caption_phone");
  assert.ok(t.fdDesignerHtml.includes('content:"联系电话\r\n "'));
  assert.ok(t.fdDesignerHtml.includes("联系电话<BR>&nbsp;"));
  assert.equal(caption.props.content,"联系电话\r\n ");
  assert.equal(caption.sourceProps.designerValues.content,"联系电话\r\n ");
  assert.equal(s.form.controls.find(f=>f.id==="caption_phone").sourceProps.runtimePlainCaption,true);
  assert.equal(evidence(t.fdDesignerHtml,t.fdDisplayJsp),true);
  assert.equal(evidence(t.fdDesignerHtml.replace("\r\n","\n"),t.fdDisplayJsp),true,"Literal LF is the same declared terminal break");
  assert.equal(sourceMobileCaptionGrids(d.form).has("layout.row-0"),true);
});

it("preserves PC, field values and full source content while only mobile tracks gain intrinsic minima",()=>{
  const d=draft(),before=structuredClone(d),p=prepareSample(d),v=viewOf(p.update),pc=grid(v,"desktop"),m=grid(v,"mobile");
  assert.deepEqual(m.controlProps.colsStyle,pc.controlProps.colsStyle.map(s=>({...s,value:`minmax(max-content, ${Number.parseFloat(s.value)}fr)`})));
  assert.deepEqual(m.controlProps.style,{overflowX:"auto"});
  assert.deepEqual(m.children,pc.children);assert.deepEqual(d,before);assert.equal(p.verify(p.update).ok,true);
});

it("rejects absent, mismatched, repeated, attributed or executable break markup at either end",()=>{
  const t=template();
  for(const change of [
    html=>html.replace("联系电话<BR>&nbsp;","联系电话&nbsp;"),
    html=>html.replace("联系电话<BR>&nbsp;","联系<BR>电话&nbsp;"),
    html=>html.replace("联系电话<BR>&nbsp;","联系电话<BR><BR>&nbsp;"),
    html=>html.replace("联系电话<BR>&nbsp;",'联系电话<BR style="color:red">&nbsp;'),
    html=>html.replace("联系电话<BR>&nbsp;","联系电话<BR>&nbsp;额外内容"),
    html=>html.replace("联系电话<BR>&nbsp;","联系电话&lt;BR&gt;&nbsp;"),
    html=>html.replace("联系电话<BR>&nbsp;","联系电话<SCRIPT>void(0)</SCRIPT><BR>&nbsp;")
  ]) for(const side of ["designer","runtime"]){
    const changed=change(side==="designer"?t.fdDesignerHtml:t.fdDisplayJsp);
    assert.notEqual(changed,side==="designer"?t.fdDesignerHtml:t.fdDisplayJsp);
    assert.equal(evidence(side==="designer"?changed:t.fdDesignerHtml,side==="runtime"?changed:t.fdDisplayJsp),false,side);
  }
});

it("does not reinterpret meaningful multiline metadata, escaped syntax, unknown keys or executable object fragments",()=>{
  const t=template(),needle='content:"联系电话\r\n "';
  for(const replacement of ['content:"联系\r\n电话"','content:"联系电话\r "','content:"联系电话\r\n\r\n "','content:"联系电话\\r\\n "',
    'content:"联系电话\r\n ",extra:"x"','content:"联系电话\r\n ",content:"联系电话\r\n "',
    'content:("联系电话\r\n ")','content:"联系电话\r\n ",...evil','content:"联系电话\r\n "/*comment*/']){
    const changed=t.fdDesignerHtml.replace(needle,replacement);assert.notEqual(changed,t.fdDesignerHtml);
    assert.equal(evidence(changed,t.fdDisplayJsp),false,replacement);
  }
});

it("requires metadata and rendered terminal breaks to agree rather than granting all BR captions",()=>{
  const t=template(),changed=t.fdDesignerHtml.replace('content:"联系电话\r\n "','content:"联系电话"');
  assert.notEqual(changed,t.fdDesignerHtml);assert.equal(evidence(changed,t.fdDisplayJsp),false);
});

it("binds the full original terminal-break semantics through trust and patch validation",()=>{
  const s=source(),d=draft(),trusted=createTrustedMigrationDsl(s,d,{externalAgentReviewed:true,reviewerName:"synthetic trailing-break source boundary",checkedAt:"2026-07-10T00:00:00.000Z"});
  assert.equal(checkTrust(s,trusted).ok,true);
  const index=d.form.fields.findIndex(f=>f.id==="caption_phone"), changed=structuredClone(d);
  changed.form.fields[index].props.content="联系电话";
  const rebound=createTrustedMigrationDsl(s,changed,{externalAgentReviewed:true,reviewerName:"synthetic changed caption source boundary"});
  const checked=checkTrust(s,rebound);assert.equal(checked.ok,false);
  assert.ok(checked.diagnostics.some(v=>v.code==="trust.form.mobile_plain_caption_source_mismatch"));
  const applied=applyEvidenceBackedPatches(changed,[],{sourceDraft:s,sourceRefs:collectSourceRefs(s),normalizeSourceRefs:true});
  assert.equal(applied.ok,false);
  assert.ok(applied.diagnostics.some(v=>v.code==="agent.patch.form.mobile_plain_caption_source_mismatch"));
});

it("rejects a readback that loses the phone caption mobile track minimum",()=>{
  const p=prepareSample(draft()),changed=structuredClone(p.update),config=xformConfig(changed),v=JSON.parse(config.viewModel[0].fdConfig);
  grid(v,"mobile").controlProps.colsStyle=structuredClone(grid(v,"desktop").controlProps.colsStyle);
  config.viewModel[0].fdConfig=JSON.stringify(v);changed.mechanisms["sys-xform"].fdConfig=JSON.stringify(config);
  const result=p.verify(changed);assert.equal(result.ok,false);assert.ok(result.diagnostics.some(d=>d.code==="readback.form.mobile_grid_mismatch"));
});

it("executes the declared terminal-break fixture through fake review, draft, native readback and record",async()=>{
  const result=await runRouteCase("mobile-caption-trailing-break-success");
  assert.equal(result.execution.ok,true);assert.equal(result.execution.transferRecord.status,"recorded");
});

it("consumes terminal whitespace entities once and rejects visible doubly encoded numeric text",()=>{
  const bad=cleanSourceFile("tests/fixtures/route-validation/mobile-caption-trailing-break/double-encoded-tail_SysFormTemplate.xml");
  assert.notEqual(bad.form.controls.find(f=>f.id==="caption_phone").sourceProps.runtimePlainCaption,true);
  assert.equal(sourceMobileCaptionGrids(draftSourceDraft(bad).form).has("layout.row-0"),false);
  const t=template();
  for(const tail of ["&amp;#160;","&amp;#xA0;","&amp;nbsp;"])for(const side of ["designer","runtime"]){
    const original=side==="designer"?t.fdDesignerHtml:t.fdDisplayJsp,changed=original.replace("联系电话<BR>&nbsp;",`联系电话<BR>${tail}`);
    assert.notEqual(changed,original);
    assert.equal(evidence(side==="designer"?changed:t.fdDesignerHtml,side==="runtime"?changed:t.fdDisplayJsp),false);
  }
  for(const tail of ["&nbsp;","&#160;","&#xA0;","&#32;","&#x20;"," \t"]){
    assert.equal(evidence(t.fdDesignerHtml.replace("联系电话<BR>&nbsp;",`联系电话<BR>${tail}`),t.fdDisplayJsp),true);
  }
});
