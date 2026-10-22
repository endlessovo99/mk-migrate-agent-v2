import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapXmlStringPuts } from "../../src/translator/xml-utils.js";
import { prepareSample } from "../helpers/persistence.js";

// The row is the fixed-asset export in caption-relationship-model/ordinary.
// Scripts below are the boundary cases, not additional source fields.
const fixture = "tests/fixtures/route-validation/caption-relationship-model/ordinary_SysFormTemplate.xml";
const pairs = [["fd_3c6687b7d57610", "fd_3c6687b047e8c6", "申请人"],
  ["fd_3c6687bb93f482", "fd_3c6687b195039e", "工号"], ["fd_3c6687b9a7ba5a", "fd_3c6687b2c4ecac", "申请部门"]];
const job = pairs[1][0];

function variant(change = () => {}) {
  const props = parseRootHashMapXmlStringPuts(readFileSync(fixture, "utf8"));
  change(props);
  const directory = mkdtempSync(join(tmpdir(), "caption-boundary-"));
  const encode = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    const file = join(directory, "variant_SysFormTemplate.xml");
    writeFileSync(file, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") + "</object></java>");
    const source = cleanSourceFile(file);
    return { source, draft: draftSourceDraft(source) };
  } finally { rmSync(directory, { force: true, recursive: true }); }
}

const folded = draft => draft.form.fields.filter(field => field.sourceProps?.foldedCaption).map(field => field.id);

it("folds a bold one-to-one title as native emphasis and leaves a colored label unfinished", () => {
  const bold = variant(props => {
    props.fdDesignerHtml = props.fdDesignerHtml
      .replace('content:"申请人",font:"",size:"",color:"",effect:"",b:"false"', 'content:"申请人",font:"",size:"",color:"",effect:"",b:"true"')
      .replace("FONT-WEIGHT: normal", "FONT-WEIGHT: bold");
    props.fdDisplayJsp = props.fdDisplayJsp.replace("FONT-WEIGHT: normal", "FONT-WEIGHT: bold");
  });
  assert.deepEqual(folded(bold.draft), pairs.map(pair => pair[0]));
  const relation = bold.source.form.captionRelations.find(item => item.fieldId === pairs[0][0]);
  assert.deepEqual(relation.evidence.titleEmphasis, ["b"]);
  const field = bold.draft.form.fields.find(item => item.id === pairs[0][0]);
  assert.equal(field.title, "申请人");
  assert.equal(field.props.hiddenLabel, undefined);
  assert.equal(bold.draft.form.fields.some(item => item.id === pairs[0][1]), false);
  const colored = variant(props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace('content:"工号",font:"",size:"",color:""', 'content:"工号",font:"",size:"",color:"#FF0000"');
  });
  assert.deepEqual(folded(colored.draft), [pairs[0][0], pairs[2][0]]);
  assert.equal(colored.draft.form.fields.some(item => item.id === pairs[1][1]), true);
  assert.equal(prepareSample(bold.draft).verify(prepareSample(bold.draft).update).ok, true);
});

it("lets an anchored unrecognized call block only its node", () => {
  const { source, draft } = variant(props => {
    props.fdDisplayJsp += `<script>document.getElementById("${job}").unknownRefresh();</script>`;
  });
  assert.deepEqual(folded(draft), [pairs[0][0], pairs[2][0]]);
  const blocked = draft.review.captionFolding.decisions.find(item => item.fieldId === job);
  assert.equal(blocked.status, "preserved");
  assert.equal(blocked.reason, "scoped_script_dependency");
  assert.equal(blocked.evidence.impact, "fixed-source-region");
  assert.equal(blocked.evidence.boundary.anchors.includes(job), true);
  assert.equal(draft.form.fields.some(item => item.id === pairs[1][1]), true);
  assert.equal(source.scripts.sources.some(script => script.javascript.includes("unknownRefresh")), true);
  const open = draft.form.fields.find(item => item.id === pairs[0][0]);
  assert.equal(open.sourceProps.foldedCaption.behavior.proofMode, "local-script-boundary");
  assert.equal(open.props.required, undefined);
});

it("treats a field value read as data and a title show as a local boundary", () => {
  const valueOnly = variant(props => {
    props.fdDisplayJsp += `<script>$('[name="extendDataFormInfo.value(${job})"]:checked').val(); $('input[name="extendDataFormInfo.value(${job})"]').prop("checked", false);</script>`;
  });
  assert.deepEqual(folded(valueOnly.draft), pairs.map(pair => pair[0]));
  const shown = variant(props => {
    props.fdDisplayJsp += `<script>$("#${pairs[1][1]}").show();</script>`;
  });
  assert.deepEqual(folded(shown.draft), [pairs[0][0], pairs[2][0]]);
  assert.equal(shown.draft.form.fields.some(item => item.id === pairs[1][1]), true);
});

it("keeps a detail-row append on one table from blocking ordinary titles", () => {
  const { draft } = variant(props => {
    props.fdDisplayJsp += `<script>DocList_AddRow(document.getElementById("TABLE_DL_fd_other_table"));</script>`;
  });
  assert.deepEqual(folded(draft), pairs.map(pair => pair[0]));
});

it("keeps a table-local width measurement from blocking ordinary titles", () => {
  const { draft } = variant(props => {
    props.fdDisplayJsp += `<script>$(function(){var tb=document.getElementById("TABLE_DL_fd_other_table");$(tb).find("tr[type='titleRow']").children().each(function(){$(this).width();});});</script>`;
  });
  assert.deepEqual(folded(draft), pairs.map(pair => pair[0]));
});

it("keeps a form-wide unrecognized effect from folding any ordinary title", () => {
  for (const code of [
    "unknownPresentationPlugin();",
    "hideAll();",
    "String.prototype.extra = function () { return this; };",
    "document.getElementsByTagName('input');",
    "document.getElementById(name);",
    "document.createElement('input');"
  ]) {
    const { draft } = variant(props => { props.fdDisplayJsp += `<script>${code}</script>`; });
    assert.equal(folded(draft).length, 0, code);
    assert.ok(draft.review.captionFolding.decisions.every(decision => decision.evidence?.impact === "unbounded-form"), code);
  }
});

it("does not let a static upload-widget style injection block ordinary titles", () => {
  const { draft } = variant(props => {
    props.fdDisplayJsp += `<script>(function () {
      var style = document.createElement("style");
      style.type = "text/css";
      style.innerHTML = [".swfuploadbutton { overflow: hidden; }"].join("");
      document.getElementsByTagName("head")[0].appendChild(style);
      window.onload = function () {
        for (var key in window) {
          if (key.indexOf("attachmentObject_") === 0 && window[key] && window[key].uploader) window[key].uploader.refresh();
        }
      };
    })();</script>`;
  });
  assert.deepEqual(folded(draft), pairs.map(pair => pair[0]));
  const boundary = draft.form.fields[0].sourceProps.foldedCaption.behavior.residualImpact.localBoundary;
  assert.ok(boundary.selectors.some(selector => selector.includes(".swfuploadbutton")));
});
