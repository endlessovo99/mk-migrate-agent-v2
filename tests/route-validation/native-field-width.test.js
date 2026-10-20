import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cleanSourceFile } from "../../src/translator/index.js";
// Preserve the retained source-width contract explicitly.
import { draftSourceDraft } from "../helpers/source-sized-draft.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { runtimeIndependentCaptionEvidence } from "../../src/translator/runtime-independent-caption.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { runRouteCase } from "./run-route-case.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const base = "tests/fixtures/route-validation/native-field-width/";
const amountFile = `${base}amount-caption_SysFormTemplate.xml`;
const selectFile = `${base}single-selector_SysFormTemplate.xml`;
const stages = file => { const source = cleanSourceFile(file); return { source, dsl: draftSourceDraft(source) }; };
function parentOf(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (value.children?.some(child => child.key === key)) return value;
  return (value.children || []).map(child => parentOf(child, key)).find(Boolean);
}
function nativeView(update) { return JSON.parse(xformConfig(update).viewModel[0].fdConfig); }
function replaceView(update, change) {
  const next = structuredClone(update), config = xformConfig(next), view = JSON.parse(config.viewModel[0].fdConfig);
  change(view); config.viewModel[0].fdConfig = JSON.stringify(view);
  next.mechanisms["sys-xform"].fdConfig = JSON.stringify(config); return next;
}
function variant(file, change) {
  const properties = parseRootHashMapStringPuts(readFileSync(file, "utf8")); change(properties);
  const dir = mkdtempSync(join(tmpdir(), "native-width-")), path = join(dir, "variant_SysFormTemplate.xml");
  const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    writeFileSync(path, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(properties).map(([k, v]) => `<void method="put"><string>${k}</string><string>${escape(v)}</string></void>`).join("") + '</object></java>');
    return stages(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("native field width route validation", () => {
  it("fills a singleton widthless selector cell independently on both surfaces", () => {
    const { dsl } = stages(selectFile), prepared = prepareSample(dsl), view = nativeView(prepared.update);
    for (const scene of ["desktop", "mobile"]) assert.deepEqual(parentOf(view.view.render[scene][0], "fd_single").controlProps.style, {
      flex: "1 1 0", minWidth: 0, maxWidth: "100%", overflow: "visible", width: "100%"
    });
    assert.equal(prepared.verify(prepared.update).ok, true);
  });

  it("folds the runtime-proven caption into the native title while retaining its source and input width", () => {
    const { source, dsl } = stages(amountFile);
    assert.deepEqual(source.form.controls.map(field => field.id), ["fd_caption_actual", "fd_amount"]);
    assert.deepEqual(dsl.form.fields.map(field => field.id), ["fd_amount"]);
    const field = dsl.form.fields.find(field => field.id === "fd_amount");
    assert.equal(field.title, "Amount");
    assert.notEqual(field.props.hiddenLabel, true);
    assert.equal(field.sourceProps.designerValues._label_bind_id, "fd_caption_missing");
    assert.equal(field.sourceProps.boundCaption, undefined);
    assert.equal(source.form.controls.find(control => control.id === "fd_amount").sourceProps.layoutCell.relation,
      "runtime-independent-title-cell");
    const prepared = prepareSample(dsl), view = nativeView(prepared.update);
    assert.equal(field.sourceProps.designerValues.width, "120");
    assert.deepEqual(dsl.form.layout.mkTree[0].children[0].contentFlow.items[0].width, { value: 120, unit: "px" });
    assert.equal(parentOf(view.view.render.desktop[0], "fd_amount").controlProps.style.width, "297px");
    assert.equal(parentOf(view.view.render.mobile[0], "fd_amount").controlProps.style.width, "152px");
    assert.equal(prepared.verify(prepared.update).ok, true);
  });

  it("rejects title changes, hiding and fabricated or lost source facts after the runtime caption fold", () => {
    const { source, dsl } = stages(amountFile), index = dsl.form.fields.findIndex(field => field.id === "fd_amount");
    assert.notEqual(dsl.form.fields[index].props.hiddenLabel, true);
    assert.equal(dsl.form.fields[index].title, "Amount");
    assert.equal(checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true })).ok, true);
    for (const mutate of [
      d => { d.form.fields[index].props.hiddenLabel = true; },
      d => { d.form.fields[index].title = "Wrong"; },
      d => { delete d.form.fields[index].sourceProps.foldedCaption; },
      d => { d.form.fields[index].sourceProps.foldedCaption.id = "fd_caption_invented"; },
      d => { d.form.fields[index].sourceProps = {}; },
      d => { d.form.fields[index].sourceProps.layoutCell.relation = "other"; },
      d => { d.form.fields[index].sourceRef = source.form.controls.find(field => field.id === "fd_caption_actual").sourceRef; },
      d => { d.form.fields.push(structuredClone(d.form.fields[0])); },
      d => { d.form.fields[0].id = "fd_replacement";
        const replace = x => { if (!x || typeof x !== "object") return; for (const key of Object.keys(x)) { if (x[key] === "fd_amount") x[key] = "fd_replacement"; else replace(x[key]); } };
        replace(d.form.layout); }
    ]) {
      const next = structuredClone(dsl); mutate(next);
      assert.equal(checkTrust(source, createTrustedMigrationDsl(source, next, { externalAgentReviewed: true })).ok, false);
    }
  });

  for (const [name, mutate] of [
    ["runtime table identity", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace("main_fixture", "other_table"); }],
    ["missing runtime table identity", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace(' id="main_fixture"', ""); }],
    ["duplicate runtime table", p => { p.fdDisplayJsp += p.fdDisplayJsp; }],
    ["runtime row mismatch", p => { p.fdDisplayJsp = p.fdDisplayJsp.replaceAll('row="0"', 'row="1"'); }],
    ["runtime column mismatch", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('column="1,2,3"', 'column="2,3,4"'); }],
    ["source colspan mismatch", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('colspan="3"', 'colspan="2"'); }],
    ["rowspan", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('<td class=', '<td rowspan="2" class='); }],
    ["source binding points to another real control", p => { p.fdDesignerHtml += '<input id="fd_caption_missing"/>'; }],
    ["duplicate source caption identity", p => { p.fdDesignerHtml += `<label fd_type="textLabel" fd_values='{id:"fd_caption_actual",content:"Other"}'>Other</label>`; }],
    ["source mixed caption HTML", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('>Amount</label>', '><b>Amount</b></label>'); }],
    ["runtime mixed caption HTML", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('>Amount</label>', '><b>Amount</b></label>'); }],
    ["runtime encoded caption HTML", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('>Amount</label>', '>&lt;b&gt;Amount&lt;/b&gt;</label>'); }],
    ["runtime text conflict", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('>Amount</label>', '>Different</label>'); }],
    ["runtime conditional caption", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('<label>Amount</label>', '<c:if test="${condition}"><label>Amount</label></c:if>'); }],
    ["runtime hidden caption", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('<label>', '<label style="display:none">'); }],
    ["runtime caption CSS class", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('<label>', '<label class="unknown">'); }],
    ["JSP conditional surrounding table", p => { p.fdDisplayJsp = '<% if (condition) { %>' + p.fdDisplayJsp + '<% } %>'; }],
    ["HTML comment caption", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('<label>Amount</label>', '<!-- <label>Amount</label> -->'); }],
    ["JSP comment caption", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('<label>Amount</label>', '<%-- <label>Amount</label> --%>'); }],
    ["script string caption", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('<label>Amount</label>', `<script>var text = '<label>Amount</label>';</script>`); }],
    ["code example caption", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('<label>Amount</label>', '<code><label>Amount</label></code>'); }],
    ["additional source editor", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('<input style=', '<input/><input style='); }],
    ["source binding disabled", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('_label_bind:"true"', '_label_bind:"false"'); }],
    ["runtime renderer differs", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('xform:xtext', 'xform:text'); }],
    ["runtime editor has its own label", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('<xform:xtext ', '<xform:xtext showLabel="true" '); }],
    ["runtime width differs", p => { p.fdDisplayJsp = p.fdDisplayJsp.replaceAll('120px', '140px'); }],
    ["runtime duplicate width", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('width:120px', 'width:120px;width:auto'); }],
    ["runtime percentage width", p => { p.fdDisplayJsp = p.fdDisplayJsp.replaceAll('120px', '40%'); }],
    ["duplicate runtime property", p => { p.fdDisplayJsp += '<xform:text property="extendDataFormInfo.value(fd_amount)"/>'; }],
    ["runtime conditional value", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('<div style=', '<xform:editShow><div style=').replace('</div>', '</div></xform:editShow>'); }],
    ["binding points to opaque JSP control", p => { p.fdDesignerHtml += `<div fd_type="jsp" fd_values='{id:"fd_caption_missing"}'><input value="markup sample"/></div>`; }],
    ["binding points to textarea opening identity", p => { p.fdDesignerHtml += '<textarea id="fd_caption_missing">sample</textarea>'; }],
    ["inner input ID differs", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('<input style=', '<input id="fd_other_actual" style='); }],
    ["inner input property differs", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('<input style=', '<input property="extendDataFormInfo.value(fd_other_actual)" style='); }],
    ["inner input name differs", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('<input style=', '<input name="fd_other_actual" style='); }],
    ...["display:/**/none", "display/**/:none", "visibility:/**/hidden", "opacity:0.0", "font-size:0", "color:transparent", "clip:rect(0,0,0,0)", "transform:scale(0)", "width:0", "display:none!important"].map(style => [
      `unproven runtime caption style ${style}`, p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('<label>', `<label style="${style}">`); }
    ]),
    ["hidden runtime title cell", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('<td class=', '<td style="color:transparent" class='); }],
    ["hidden runtime row", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('<tr>', '<tr style="opacity:0.0">'); }],
    ["conflicting source caption style", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('<label fd_type=', '<label style="display:/**/none" fd_type='); }]
  ]) {
    it(`does not infer an independent caption from ${name}`, () => {
      const properties = parseRootHashMapStringPuts(readFileSync(amountFile, "utf8")); mutate(properties);
      assert.equal(runtimeIndependentCaptionEvidence(properties.fdDesignerHtml, properties.fdDisplayJsp).size, 0);
      const { source } = variant(amountFile, mutate);
      assert.notEqual(source.form.controls.find(field => field.id === "fd_amount")?.sourceProps.layoutCell?.relation,
        "runtime-independent-title-cell");
    });
  }

  it("ignores non-rendered examples without discarding the actual caption evidence", () => {
    const { source, dsl } = variant(amountFile, p => {
      p.fdDesignerHtml += `<script>var sample = '<input id="fd_caption_missing"/>';</script>`;
      p.fdDisplayJsp = '<%@ page language="java" %><!-- <table id="main_fixture"></table> --><%-- <xform:xtext property="extendDataFormInfo.value(fd_amount)"/> --%>' + p.fdDisplayJsp;
    });
    assert.equal(source.form.controls.find(field => field.id === "fd_amount").sourceProps.layoutCell.relation,
      "runtime-independent-title-cell");
    assert.equal(source.form.controls.find(field => field.id === "fd_caption_actual").title, "Amount");
    assert.equal(dsl.form.fields.find(field => field.id === "fd_caption_actual")?.componentId, "xform-description");
    assert.equal(dsl.form.fields.find(field => field.id === "fd_amount").title, "Amount");
    assert.equal(dsl.form.fields.find(field => field.id === "fd_amount").props.hiddenLabel, true);
  });

  it("retains only real opaque opening identities, not sample markup in their bodies", () => {
    const { source } = variant(amountFile, p => {
      p.fdDesignerHtml += `<div fd_type="jsp" fd_values='{id:"fd_real_script"}'><input id="fd_caption_missing"/></div><textarea id="fd_real_textarea"><input id="fd_caption_missing"/></textarea>`;
    });
    assert.equal(source.form.controls.find(field => field.id === "fd_amount").sourceProps.layoutCell.relation,
      "runtime-independent-title-cell");
  });

  it("accepts an explicitly matching inner input identity and the actual static caption appearance", () => {
    const { source } = variant(amountFile, p => {
      p.fdDesignerHtml = p.fdDesignerHtml.replace('<input style=', '<input id="fd_amount" name="fd_amount" property="extendDataFormInfo.value(fd_amount)" style=');
      p.fdDisplayJsp = p.fdDisplayJsp.replace('<label>', '<label style="TEXT-DECORATION:none; WIDTH:auto; FONT-WEIGHT:normal; FONT-STYLE:normal; DISPLAY:inline">');
    });
    assert.equal(source.form.controls.find(field => field.id === "fd_amount").sourceProps.layoutCell.relation,
      "runtime-independent-title-cell");
  });

  it("keeps the existing exact Designer binding path independent of the new visibility proof", () => {
    const { source, dsl } = variant(amountFile, p => {
      p.fdDesignerHtml = p.fdDesignerHtml.replace('fd_caption_missing', 'fd_caption_actual');
      p.fdDisplayJsp = p.fdDisplayJsp.replace('<label>', '<label style="font-size:14px">');
    });
    const field = source.form.controls.find(field => field.id === "fd_amount");
    assert.equal(field.sourceProps.boundCaption.id, "fd_caption_actual");
    assert.notEqual(field.sourceProps.layoutCell.relation, "runtime-independent-title-cell");
    assert.equal(dsl.form.fields.find(field => field.id === "fd_amount").props.hiddenLabel, true);
  });

  it("keeps multi-inline, multiline and explicit widths out of selector fill", () => {
    for (const [kind, change, expectedWidth] of [
      ["pixels", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('<div fd_type=', '<div style="width:180px" fd_type='); }, "180px"],
      ["percent", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('<div fd_type=', '<div style="width:40%" fd_type='); }, "40%"],
      ["break", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('</div></td>', '</div><br/></td>'); }, undefined],
      ["inline text", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('</div></td>', `</div><label fd_type="textLabel" fd_values='{id:"fd_unit",content:"unit",b:"true"}'>unit</label></td>`); }, undefined]
    ]) {
      const { dsl } = variant(selectFile, change), prepared = prepareSample(dsl), view = nativeView(prepared.update);
      const style = parentOf(view.view.render.desktop[0], "fd_single").controlProps.style;
      assert.equal(style.flex, expectedWidth ? "0 0 auto" : "0 1 auto", kind);
      assert.equal(style.width, expectedWidth, kind);
      assert.equal(prepared.verify(prepared.update).ok, true, kind);
    }
  });

  it("rejects fill loss, fake sizing and surface mismatches from actual native payload", () => {
    const prepared = prepareSample(stages(selectFile).dsl);
    for (const mutation of [
      style => { style.flex = "0 1 auto"; delete style.width; },
      style => { style.width = "120px"; },
      style => { style.minWidth = 120; },
      style => { style.flexGrow = 1; },
      style => { delete style.width; }
    ]) {
      const next = replaceView(prepared.update, view => mutation(parentOf(view.view.render.mobile[0], "fd_single").controlProps.style));
      assert.equal(prepared.verify(next).ok, false);
    }
    const amount = prepareSample(stages(amountFile).dsl);
    const fakeFill = replaceView(amount.update, view => {
      const style = parentOf(view.view.render.desktop[0], "fd_amount").controlProps.style;
      style.flex = "1 1 0"; style.width = "100%";
    });
    assert.equal(amount.verify(fakeFill).ok, false);
  });

  it("rejects model patches that hide, rename or falsify the folded runtime caption", () => {
    const { source, dsl } = stages(amountFile), index = dsl.form.fields.findIndex(field => field.id === "fd_amount");
    assert.equal(dsl.form.fields[index].title, "Amount");
    assert.notEqual(dsl.form.fields[index].props.hiddenLabel, true);
    for (const [property, value] of [
      ["props", { ...dsl.form.fields[index].props, hiddenLabel: true }],
      ["title", "Wrong"],
      ["sourceProps", {}],
      ["sourceProps/foldedCaption", { ...dsl.form.fields[index].sourceProps.foldedCaption, id: "fd_caption_invented" }]
    ]) {
      const result = applyEvidenceBackedPatches(dsl, [{ op: "replace", path: `/form/fields/${index}/${property}`, value,
        sourceRefs: [dsl.form.fields[index].sourceRef], evidence: ["Attempted native caption substitution"],
        confidence: 1, rationale: "Negative proof" }],
        { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
      assert.equal(result.ok, false, property);
    }
  });

  for (const id of ["singleton-select-width-success", "runtime-independent-caption-width-success"]) {
    it(`retains review, trust, dry-run, fake execution and transfer record: ${id}`, async () => {
      const result = await runRouteCase(id);
      assert.equal(result.execution.status, "written");
      assert.equal(result.execution.readback.status, "verified");
    });
  }
});
