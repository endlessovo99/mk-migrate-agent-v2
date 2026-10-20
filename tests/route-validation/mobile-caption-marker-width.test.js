import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { cleanSourceFile } from "../../src/translator/index.js";
// Preserve the retained source-width contract explicitly.
import { draftSourceDraft } from "../helpers/source-sized-draft.js";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { runtimeCaptionWidthEvidence, runtimePlainCaptionEvidence } from "../../src/translator/runtime-caption-width.js";
import { sourceMobileCaptionGrids } from "../../src/dsl/source-mobile-caption-grid.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
const file="tests/fixtures/route-validation/mobile-caption-marker-width/marker-width_SysFormTemplate.xml";
const template=()=>parseSysFormTemplateXml(readFileSync(file,"utf8"));

it("consumes a complete runtime-widthless marker proof when deriving caption flow, preserving source bytes and helper",()=>{
  const t=template(),s=cleanSourceFile(file),d=draftSourceDraft(s),caption=d.form.fields.find(f=>f.id==="caption_main");
  assert.ok(t.fdDesignerHtml.includes('style="WIDTH:48px"'));
  assert.equal(runtimeCaptionWidthEvidence(t.fdDesignerHtml,t.fdDisplayJsp).has("caption_main"),false,"Legacy proof cannot consume the visible JSP wrapper");
  assert.equal(runtimePlainCaptionEvidence(t.fdDesignerHtml,t.fdDisplayJsp).has("caption_main"),true);
  assert.equal(caption.sourceProps.runtimePlainCaption,true);
  assert.deepEqual(caption.sourceProps.runtimePlainCaptionMarkerIds,["state_marker"]);
  assert.equal(s.form.layout.rows[0].cells[0].contentFlow.items[0].width,undefined,"A proven designer-only sizing handle must not survive as source control width");
  assert.equal(d.form.layout.mkTree[0].children[0].contentFlow.items[0].width,undefined);
  assert.equal(d.form.layout.sourceGrid.rows[0].cells[0].contentFlow.items[0].width,undefined);
  assert.equal(sourceMobileCaptionGrids(d.form).has("layout.row-0"),true);
  assert.deepEqual(d.form.fields.find(f=>f.id==="state_marker").props.defaultValue,{kind:"literal",value:"retained-state"});
  const p=prepareSample(d),v=JSON.parse(xformConfig(p.update).viewModel[0].fdConfig),gr=scene=>v.view.render[scene][0].children[0].children[0].children[0];
  assert.deepEqual(gr("mobile").controlProps.colsStyle,gr("desktop").controlProps.colsStyle.map((x,index)=>index===0?{...x,value:`minmax(max-content, ${Number.parseFloat(x.value)}fr)`}:x));
  assert.deepEqual(gr("mobile").children,gr("desktop").children);
  assert.equal(p.verify(p.update).ok,true);
  assert.equal(checkTrust(s,createTrustedMigrationDsl(s,d,{externalAgentReviewed:true,reviewerName:"synthetic marker sizing evidence"})).ok,true);
});

it("keeps an actual rendered fixed caption width and refuses incomplete marker or metadata width evidence",()=>{
  const t=template();
  for(const [designer,runtime] of [
    [t.fdDesignerHtml,t.fdDisplayJsp.replace('<LABEL id="caption_main">','<LABEL id="caption_main" style="WIDTH:48px">')],
    [t.fdDesignerHtml,t.fdDisplayJsp.replace('value="retained-state"','value="changed-state"')]
  ]){
    assert.ok(designer!==t.fdDesignerHtml||runtime!==t.fdDisplayJsp);
    assert.equal(runtimePlainCaptionEvidence(designer,runtime).has("caption_main"),false);
  }
  const metadata=[{id:"caption_main",source:{metadataAttributes:{width:"48"}}}];
  assert.equal(runtimePlainCaptionEvidence(t.fdDesignerHtml,t.fdDisplayJsp,metadata).has("caption_main"),false);
});
