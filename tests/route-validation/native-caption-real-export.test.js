import assert from "node:assert/strict";
import { it } from "node:test";
import { auditCaptionFolding, cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/native-caption-real-export/news_SysFormTemplate.xml";
const applicantFixture = "tests/fixtures/route-validation/native-caption-real-export/applicant_SysFormTemplate.xml";
const applicantId = "fd_325c0266a887c4";
const captionId = "fd_325c005d07ab62";

it("verifies the real export through review, trust and fake native persistence", async () => {
  const result = await runRouteCase("native-caption-real-news-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.dsl.review.captionFolding.decisions.filter(item => item.status === "folded").length, 4);
});

function applicantVariant(change = () => {}, input = applicantFixture) {
  const values = parseRootHashMapStringPuts(readFileSync(input, "utf8"));
  change(values);
  const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const dir = mkdtempSync(join(tmpdir(), "real-caption-"));
  try {
    const path = join(dir, "variant_SysFormTemplate.xml");
    writeFileSync(path, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(values).map(([key, value]) => `<void method="put"><string>${key}</string><string>${escape(value)}</string></void>`).join("") +
      "</object></java>");
    const source = cleanSourceFile(path);
    return { source, draft: draftSourceDraft(source) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it("folds the real default-sized applicant title using its unique runtime owner despite a false binding flag", () => {
  const { source, draft } = applicantVariant();
  assert.equal(source.form.controls.find(field => field.id === applicantId).sourceProps.designerValues._label_bind, "false");
  assert.equal(draft.form.fields.find(field => field.id === applicantId).sourceProps.foldedCaption?.id, captionId);
  assert.equal(draft.form.fields.some(field => field.id === captionId), false);
});

it("isolates an unrelated malformed runtime row without granting authority to that row", () => {
  const { draft } = applicantVariant(values => {
    values.fdDisplayJsp = values.fdDisplayJsp.replace("</TBODY>",
      '<TR><TD><xform:xtext property="extendDataFormInfo.value(fd_broken)"/></DIV></TD></TR></TBODY>');
  });
  assert.equal(draft.form.fields.find(field => field.id === applicantId).sourceProps.foldedCaption?.id, captionId);
});

it("allows unrelated data-only calculations without weakening dynamic script protection", () => {
  const { draft } = applicantVariant(values => {
    values.fdDisplayJsp += '<script>function amount(){return Number(GetXFormFieldValueById("fd_amount")) + 1;}</script>';
  });
  assert.equal(draft.form.fields.find(field => field.id === applicantId).sourceProps.foldedCaption?.id, captionId);
});

it("accepts exporter style mirrors only when they agree with the actual caption cell", () => {
  const { draft } = applicantVariant(values => {
    for (const key of ["fdDesignerHtml", "fdDisplayJsp"]) values[key] = values[key]
      .replace('class=td_normal_title', 'class=td_normal_title style_borderbottomwidth="null" style_bordertopwidth="null" style_borderleftwidth="null" style_borderrightwidth="null" style_textalign="left" style_verticalalign="middle"')
      .replace('WIDTH: 168px', 'WIDTH: 168px; TEXT-ALIGN: left; VERTICAL-ALIGN: middle');
  });
  assert.equal(draft.form.fields.find(field => field.id === applicantId).sourceProps.foldedCaption?.id, captionId);
});

it("ignores only boundary whitespace in a literal exported caption", () => {
  const { draft } = applicantVariant(values => {
    values.fdDesignerHtml = values.fdDesignerHtml.replace('content:"申请人"', 'content:"申请人\r\n "')
      .replace('>申请人</LABEL>', '>\r\n申请人\r\n </LABEL>');
    values.fdDisplayJsp = values.fdDisplayJsp.replace('>申请人</LABEL>', '>\r\n申请人\r\n </LABEL>');
  });
  assert.equal(draft.form.fields.find(field => field.id === applicantId).sourceProps.foldedCaption?.id, captionId);
});

it("recognizes a single exporter terminal break backed by the literal title's trailing newline", () => {
  const { draft } = applicantVariant(values => {
    values.fdDesignerHtml = values.fdDesignerHtml.replace('content:"申请人"', 'content:"申请人\r\n"')
      .replace('>申请人</LABEL>', '>申请人<BR></LABEL>');
    values.fdDisplayJsp = values.fdDisplayJsp.replace('>申请人</LABEL>', '>申请人<BR></LABEL>');
  });
  assert.equal(draft.form.fields.find(field => field.id === applicantId).sourceProps.foldedCaption?.id, captionId);
});

it("matches repeated runtime title text by its unique physical cell", () => {
  const { draft } = applicantVariant(values => {
    values.fdDesignerHtml = values.fdDesignerHtml.replace('</TBODY>', '<TR><TD row="3" column="0"><LABEL fd_type="textLabel" fd_values=\'{id:"other_caption",content:"申请人"}\'>申请人</LABEL></TD><TD row="3" column="1"><DIV fd_type="inputText" fd_values=\'{id:"fd_other",label:"申请人",_label_bind:"true",_label_bind_id:"other_caption"}\'><INPUT id="fd_other"/></DIV></TD></TR></TBODY>');
    values.fdDisplayJsp = values.fdDisplayJsp.replace('</TBODY>', '<TR><TD row="3" column="0"><LABEL>申请人</LABEL></TD><TD row="3" column="1"><xform:xtext property="extendDataFormInfo.value(fd_other)"/></TD></TR></TBODY>');
  });
  assert.equal(draft.form.fields.find(field => field.id === applicantId).sourceProps.foldedCaption?.id, captionId);
  assert.equal(draft.form.fields.find(field => field.id === "fd_other").sourceProps.foldedCaption?.id, "other_caption");
});

it("proves a real address editor as one owner from its matching id/name bindings", () => {
  const { source, draft } = applicantVariant(values => {
    values.fdDesignerHtml = values.fdDesignerHtml.replace(/(<(?:LABEL|DIV)[^>]*fd_3d5df07476e8b4[^>]*>)/,
      opening => opening.replace('_label_bind:"true"', '_label_bind:"false"'));
  }, fixture);
  assert.equal(source.form.controls.find(field => field.id === "fd_3d5df07476e8b4").sourceProps.designerValues._label_bind, "false");
  assert.equal(draft.form.fields.find(field => field.id === "fd_3d5df07476e8b4").sourceProps.foldedCaption?.id, "fd_3352b877be22ce");
});

it("scopes a complete field-change callback to its fixed affected field", () => {
  const { source, draft } = applicantVariant(values => {
    values.fdDisplayJsp += '<script>AttachXFormValueChangeEventById("fd_325c028ef96556",function(value,domElement){var field=GetXFormFieldById("fd_325c028ef96556")[0];if(value.indexOf("A")>=0){field.value="A";}else{field.value="";}});</script>';
  });
  assert.equal(draft.form.fields.find(field => field.id === applicantId).sourceProps.foldedCaption?.id, captionId);
  assert.equal(draft.form.fields.find(field => field.id === "fd_325c028ef96556").props.hiddenLabel, true);
  assert.equal(auditCaptionFolding(source, draft).ok, true);
});

it("does not infer a bounded effect through an unresolved mutable closure", () => {
  const { draft } = applicantVariant(values => {
    values.fdDisplayJsp += `<script>var id="fd_325c028ef96556";AttachXFormValueChangeEventById("fd_325c028ef96556",function(){GetXFormFieldById(id)[0].value="x";});id="${applicantId}";</script>`;
  });
  assert.equal(draft.form.fields.some(field => field.id === captionId), true);
});

it("includes non-dispatcher runtime handlers in the complete script domain", () => {
  const { draft } = applicantVariant(values => {
    values.fdDisplayJsp = values.fdDisplayJsp.replace('onValueChange="__xformDispatch"', 'onValueChange="changePresentation()"');
  });
  assert.equal(draft.form.fields.some(field => field.id === captionId), true);
});

it("fails closed when malformed unrelated attributes can hide an effective runtime handler", () => {
  const { draft } = applicantVariant(values => {
    values.fdDisplayJsp += '<BUTTON onclick="changePresentation()" disabled disabled>X</BUTTON>';
  });
  assert.equal(draft.form.fields.some(field => field.id === captionId), true);
  assert.equal(draft.review.captionFolding.decisions.find(item => item.fieldId === applicantId).evidence.reason,
    "runtime_attributes_unproven");
});

it("includes runtime script bodies even when Designer JSP scripts take precedence in migration", () => {
  const { draft } = applicantVariant(values => {
    values.fdDesignerHtml += '<DIV fd_type="jsp" id="js1"><INPUT type="hidden" value="&lt;script&gt;Number(1);&lt;/script&gt;"/></DIV>';
    values.fdDisplayJsp += '<script>changePresentation();</script>';
  });
  assert.equal(draft.form.fields.some(field => field.id === captionId), true);
});

it("includes event handlers on text controls masked from caption markup", () => {
  const { draft } = applicantVariant(values => {
    values.fdDisplayJsp += '<TEXTAREA onclick="changePresentation()">inert text</TEXTAREA>';
  });
  assert.equal(draft.form.fields.some(field => field.id === captionId), true);
});

it("bounds an optional boolean field setter flag without accepting a callback flag", () => {
  const { draft } = applicantVariant(values => {
    values.fdDisplayJsp += '<script>AttachXFormValueChangeEventById("fd_325c028ef96556",function(value){SetXFormFieldValueById("fd_325c028ef96556",value,false);});</script>';
  });
  assert.equal(draft.form.fields.find(field => field.id === applicantId).sourceProps.foldedCaption?.id, captionId);
  const rejected = applicantVariant(values => {
    values.fdDisplayJsp += '<script>AttachXFormValueChangeEventById("fd_325c028ef96556",function(value){SetXFormFieldValueById("fd_325c028ef96556",value,changePresentation);});</script>';
  });
  assert.equal(rejected.draft.form.fields.some(field => field.id === captionId), true);
});

it("does not turn escaped editor contents into presentation code during caption proof", () => {
  const { source } = applicantVariant(values => {
    values.fdDesignerHtml += '<TEXTAREA>&lt;/TEXTAREA&gt;&lt;STYLE&gt;.sample{display:none}&lt;/STYLE&gt;</TEXTAREA>';
  });
  assert.equal(source.form.controls.find(field => field.id === captionId).sourceProps.staticCaptionFact?.plainText, true);
});

for (const [name, change] of [
  ["conflicting style mirror", values => {
    values.fdDesignerHtml = values.fdDesignerHtml.replace('class=td_normal_title', 'class=td_normal_title style_textalign="right"');
  }],
  ["substantive border mirror", values => {
    values.fdDesignerHtml = values.fdDesignerHtml.replace('class=td_normal_title', 'class=td_normal_title style_borderbottomwidth="2px"');
  }],
  ["interior caption newline", values => {
    values.fdDesignerHtml = values.fdDesignerHtml.replace('content:"申请人"', 'content:"申请\r\n人"').replace('>申请人</LABEL>', '>申请\r\n人</LABEL>');
  }],
  ["terminal break without literal newline evidence", values => {
    for (const key of ["fdDesignerHtml", "fdDisplayJsp"]) values[key] = values[key].replace('>申请人</LABEL>', '>申请人<BR></LABEL>');
  }],
  ["styled terminal break", values => {
    values.fdDesignerHtml = values.fdDesignerHtml.replace('content:"申请人"', 'content:"申请人\r\n"')
      .replace('>申请人</LABEL>', '>申请人<BR style="color:red"></LABEL>');
    values.fdDisplayJsp = values.fdDisplayJsp.replace('>申请人</LABEL>', '>申请人<BR style="color:red"></LABEL>');
  }],
  ["two same-text labels in the owning cell", values => {
    values.fdDisplayJsp = values.fdDisplayJsp.replace('>申请人</LABEL>', '>申请人</LABEL><LABEL>申请人</LABEL>');
  }]
]) it(`keeps the title unproven for ${name}`, () => {
  const { source, draft } = applicantVariant(change);
  assert.equal(draft.form.fields.some(field => field.id === captionId), true);
  assert.ok(source.form.controls.find(field => field.id === captionId).sourceProps.staticCaptionIssue?.reason);
});

for (const [name, script] of [
  ["unknown external call", "changePresentation();"],
  ["dynamic field lookup", "GetXFormFieldById(fieldName);"],
  ["global DOM lookup", 'document.getElementById("other").parentNode.style.display="none";'],
  ["shadowed numeric builtin", "var Number=externalTransform; Number(value);"],
  ["overwritten local function", "function amount(){return 1;} amount=externalTransform;amount();"],
  ["destructured builtin shadow", "function calc({Number}){Number(value);}"],
  ["overwritten math builtin", "Math.floor=externalTransform;Math.floor(value);"],
  ["element handle traversal", 'GetXFormFieldById("fd_other").offsetParent.previousElementSibling.hidden=true;'],
  ["catch builtin shadow", "try{throw externalTransform;}catch(Number){Number(value);}"],
  ["catch local function shadow", "function calc(){return 1;}try{throw externalTransform;}catch(calc){calc(value);}"],
  ["out-of-scope nested function", "function wrapper(){function changePresentation(){return 1;}}changePresentation();"],
  ["with statement scope", "function calc(){return 1;}with(external){calc();}"],
  ["unknown tagged invocation", "changePresentation`other`;"],
  ["dynamic import", 'import("./presentation.js");'],
  ["for-of builtin overwrite", "for(Number of callbacks){Number(value);}"],
  ["for-in local overwrite", "function calc(){return 1;}for(calc in callbacks){calc();}"],
  ["numeric coercion of an unknown object", "Number(externalValue);"],
  ["arithmetic coercion of an unknown object", "externalValue + 1;"],
  ["update coercion of an unknown object", "externalValue++;"],
  ["compound coercion of an unknown object", "externalValue += 1;"],
  ["dynamically computed title reference", 'var suffix="325c005d07ab62";hideCaption("fd_"+suffix);']
]) it(`retains the real title for ${name}`, () => {
  const { draft } = applicantVariant(values => { values.fdDisplayJsp += `<script>${script}</script>`; });
  assert.equal(draft.form.fields.some(field => field.id === captionId), true);
  assert.equal(draft.form.fields.find(field => field.id === applicantId).props.hiddenLabel, true);
});

for (const [name, change] of [
  ["missing runtime owner", values => { values.fdDisplayJsp = ""; }],
  ["different runtime owner", values => { values.fdDisplayJsp = values.fdDisplayJsp.replaceAll(applicantId, "fd_other"); }],
  ["unknown runtime renderer", values => { values.fdDisplayJsp = values.fdDisplayJsp.replaceAll("xform:xtext", "custom:dynamic"); }],
  ["mismatching runtime renderer", values => { values.fdDisplayJsp = values.fdDisplayJsp.replaceAll("xform:xtext", "xform:datetime"); }],
  ["hidden runtime owner", values => { values.fdDisplayJsp = values.fdDisplayJsp.replace('style="WIDTH: 390px"', 'style="display:none"'); }],
  ["hidden runtime owner with explicit Designer binding", values => {
    values.fdDesignerHtml = values.fdDesignerHtml.replace('_label_bind:"false"', '_label_bind:"true"');
    values.fdDisplayJsp = values.fdDisplayJsp.replace('style="WIDTH: 390px"', 'style="display:none"');
  }],
  ["malformed title row", values => { values.fdDisplayJsp = values.fdDisplayJsp.replace(">申请人</LABEL>", ">申请人</LABEL></DIV>"); }],
  ["non-default title size", values => { values.fdDesignerHtml = values.fdDesignerHtml.replaceAll("14px", "18px"); }],
  ["dynamic table metadata", values => { values.fdDesignerHtml = values.fdDesignerHtml.replace('layout2col="undefined"', 'layout2col="${mode}"'); }]
]) it(`keeps ownership unproven for ${name}`, () => {
  const { draft } = applicantVariant(change);
  assert.equal(draft.form.fields.some(field => field.id === captionId), true);
});

for (const [name, change] of [
  ["shared visible title", values => {
    const owner = values.fdDesignerHtml.match(/<DIV[^>]*fd_325c0266a887c4[\s\S]*?<\/DIV>/)[0];
    values.fdDesignerHtml = values.fdDesignerHtml.replace(owner, owner + owner.replaceAll(applicantId, "fd_other"));
  }],
  ["shared hidden title", values => {
    const owner = values.fdDesignerHtml.match(/<DIV[^>]*fd_325c0266a887c4[\s\S]*?<\/DIV>/)[0];
    values.fdDesignerHtml = values.fdDesignerHtml.replace(owner, owner + owner.replaceAll(applicantId, "fd_other").replaceAll('canShow="true"', 'canShow="false"').replace('canShow:"true"', 'canShow:"false"'));
  }],
  ["independent caption permission", values => {
    values.fdDesignerHtml = values.fdDesignerHtml.replace(/(<LABEL[^>]*fd_325c005d07ab62[^>]*>申请人<\/LABEL>)/,
      '<DIV fd_type="right" fd_values=\'{id:"right_caption"}\'>$1</DIV>');
  }],
  ["independent editor permission", values => {
    values.fdDesignerHtml = values.fdDesignerHtml.replace(/(<DIV[^>]*fd_325c0266a887c4[\s\S]*?<\/DIV>)/,
      '<DIV fd_type="right" fd_values=\'{id:"right_owner"}\'>$1</DIV>');
  }],
  ["duplicate identity inside a malformed row", values => {
    const label = values.fdDesignerHtml.match(/<LABEL[^>]*fd_325c005d07ab62[^>]*>申请人<\/LABEL>/)[0];
    values.fdDesignerHtml = values.fdDesignerHtml.replace("</TBODY>", `<TR><TD>${label}</DIV></TD></TR></TBODY>`);
  }]
]) it(`preserves ${name} in real exporter markup`, () => {
  const { source, draft } = applicantVariant(change);
  assert.equal(draft.form.fields.some(field => field.id === captionId), true);
  assert.equal(auditCaptionFolding(source, draft).ok, true);
});

it("folds the four one-to-one titles in the unchanged real news export", () => {
  const source = cleanSourceFile(fixture);
  const draft = draftSourceDraft(source);
  const folded = draft.form.fields.filter(field => field.sourceProps?.foldedCaption);
  assert.deepEqual(folded.map(field => field.title), [
    "填报人", "申请部门", "申请单位", "发起的公司新闻流程状态"
  ]);
  assert.deepEqual(draft.form.layout.sourceGrid, source.form.layout);
  for (const field of folded) {
    assert.notEqual(field.props.hiddenLabel, true);
    assert.equal(draft.form.fields.some(other => other.id === field.sourceProps.foldedCaption.id), false);
  }
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
  assert.equal(auditCaptionFolding(source, draft).ok, true);
});

it("rejects a zero-fold claim and a deleted acceptance report for mergeable real titles", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const withoutReport = structuredClone(draft);
  delete withoutReport.review.captionFolding;
  assert.equal(auditCaptionFolding(source, withoutReport).ok, false);
  const retainedSource = structuredClone(source);
  for (const field of retainedSource.form.controls) delete field.sourceProps.staticCaptionFact;
  const incorrectlyRetained = draftSourceDraft(retainedSource);
  assert.equal(auditCaptionFolding(source, incorrectlyRetained).ok, false);
});

it("records why dynamic titles remain separate and rejects deleting their caption", () => {
  const { source, draft } = applicantVariant(values => { values.fdDisplayJsp += '<script>changePresentation();</script>'; });
  const report = auditCaptionFolding(source, draft);
  assert.equal(report.ok, true);
  assert.equal(report.decisions.find(item => item.fieldId === applicantId).reason, "dynamic_script_unproven");
  const changed = structuredClone(draft);
  changed.form.fields = changed.form.fields.filter(field => field.id !== captionId);
  assert.equal(auditCaptionFolding(source, changed).ok, false);
  const withoutOwner = structuredClone(draft);
  withoutOwner.form.fields = withoutOwner.form.fields.filter(field => field.id !== applicantId);
  assert.equal(auditCaptionFolding(source, withoutOwner).ok, false);
  const hiddenCaption = structuredClone(draft);
  hiddenCaption.form.fields.find(field => field.id === captionId).props.style = { display: "none" };
  assert.equal(auditCaptionFolding(source, hiddenCaption).ok, false);
});
