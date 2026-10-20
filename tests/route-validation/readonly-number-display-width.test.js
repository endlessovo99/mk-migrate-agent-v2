import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cleanSourceFile } from "../../src/translator/index.js";
// Preserve the retained source-width contract explicitly.
import { draftSourceDraft } from "../helpers/source-sized-draft.js";
import { sourceNumberEditors, sourceNumberDisplays } from "../../src/dsl/source-number-editor.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

it("readonly numeric display completes review, execution, native readback and recording", async () => {
  const result = await runRouteCase("readonly-number-display-width-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.readback.invariantVersion, 40);
  assert.equal(result.execution.transferRecord.status, "recorded");
});

const fixture = "tests/fixtures/route-validation/readonly-number-display-width/readonly-number-width_SysFormTemplate.xml";
const xml = readFileSync(fixture, "utf8");
const runtimeTag = '<xform:xtext property="extendDataFormInfo.value(fd_total60)" style="WIDTH: 60px;DISPLAY:inline" htmlElementProperties="readonly"/>';
const prop = "runtimeNumberDisplayWidth";
const fields = ["fd_total60", "fd_total100", "fd_readonly_number"];
const field = (dsl, id) => dsl.form.fields.find(f => f.id === id);

function stages(sourceXml) {
  const source = sourceXml === undefined ? cleanSourceFile(fixture) : sourceFromXml(sourceXml);
  const draft = draftSourceDraft(source);
  return { source, draft };
}
function trustedStages() {
  const { source, draft } = stages();
  const trusted = createTrustedMigrationDsl(source, draft, {
    externalAgentReviewed: true, reviewerName: "synthetic readonly width regression", checkedAt: "2026-10-15T00:00:00Z"
  });
  const baseline = checkTrust(source, trusted);
  assert.equal(baseline.ok, true, JSON.stringify(baseline.diagnostics));
  return { source, trusted };
}
function sourceFromXml(text) {
  const directory = mkdtempSync(join(tmpdir(), "readonly-number-width-"));
  const path = join(directory, "readonly-number-width_SysFormTemplate.xml");
  try {
    writeFileSync(path, text);
    return cleanSourceFile(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("readonly numeric native display budget", () => {
  it("preserves source value widths and adds only the desktop classic shell budget", () => {
    const { source, draft } = stages();
    const prepared = prepareSample(draft), config = xformConfig(prepared.update);
    const view = JSON.parse(config.viewModel[0].fdConfig);
    assert.equal(parentOf(view.view.render.desktop[0], "fd_total60").controlProps.style.width, "92px");
    assert.equal(parentOf(view.view.render.desktop[0], "fd_total100").controlProps.style.width, "132px");
    assert.equal(parentOf(view.view.render.desktop[0], "fd_readonly_number").controlProps.style.width, "92px");
    for (const id of fields) {
      const raw = source.form.controls.find(f => f.id === id);
      assert.deepEqual(raw.sourceProps[prop].valuePx, Number(raw.sourceProps.designerValues.width));
      assert.equal(raw.sourceProps[prop].renderer, "xform:xtext");
      assert.equal(raw.sourceProps[prop].property, `extendDataFormInfo.value(${id})`);
      assert.ok(Number.isInteger(raw.sourceProps[prop].offset));
      assert.equal(field(draft, id).props.hiddenLabel, true);
      assert.equal(field(draft, id).props.readOnly, true);
    }
    assert.equal(prepared.verify(prepared.update).ok, true);
    assert.equal(field(draft, "fd_total60").componentId, "xform-calculate");
    assert.deepEqual(field(draft, "fd_total60").props.calculation, {
      kind: "formula", expression: "$fd_input$ * 2", displayExpression: "$Input$ * 2", fieldIds: ["fd_input"]
    });
    assert.equal(field(draft, "unit_total60").props.content, "元");
    const rawFlow = source.form.layout.rows[1].cells[1].contentFlow;
    assert.deepEqual(rawFlow.items.find(x => x.referenceId === "fd_total60").width, { value: 60, unit: "px" });
  });

  it("locks the desktop padding premise and retains mobile value budgets", () => {
    const { source, draft } = stages();
    assert.deepEqual([...sourceNumberEditors(source.form).keys()], ["fd_input"]);
    assert.deepEqual([...sourceNumberEditors(draft.form).keys()], ["fd_input"]);
    const prepared = prepareSample(draft), config = xformConfig(prepared.update);
    const view = JSON.parse(config.viewModel[0].fdConfig);
    for (const id of fields) assert.deepEqual(view.controlStyle[id]?.desktop, {
      desktopTheme: "classic", desktopPaddingMode: "standard", layout: "horizontal"
    });
    for (const [id, width] of [["fd_total60", "92px"], ["fd_total100", "132px"], ["fd_readonly_number", "92px"], ["fd_input", "112px"]]) {
      assert.equal(parentOf(view.view.render.mobile[0], id).controlProps.style.width, width);
    }
    assert.equal(parentOf(view.view.render.desktop[0], "fd_input").controlProps.style.width, "112px");
    assert.equal(parentOf(view.view.render.desktop[0], "fd_visible_total").controlProps.style.width, "100px");
    assert.notEqual(field(draft, "fd_visible_total").props.hiddenLabel, true);
    const native = id => JSON.parse(config.dataModel[0].fdFields.find(f => JSON.parse(f.fdAttribute).config.controlProps.name === id).fdAttribute).config.controlProps;
    assert.equal(native("fd_input").showCount, false);
    assert.equal(native("fd_readonly_number").showCount, true);
    assert.equal(native("fd_total60").showStatus, "readOnly");
    assert.equal(native("fd_total60").valueType.precision, 2);
    assert.equal(native("fd_total60").valueType.groupingUsed, false);
    assert.equal(native("fd_total60").numberFormat, undefined);
  });

  it("readback rejects loss of the display width or classic padding contract", () => {
    const prepared = prepareSample(stages().draft);
    assert.equal(prepared.verify(prepared.update).ok, true);
    const widthLost = structuredClone(prepared.update), widthConfig = xformConfig(widthLost);
    const view = JSON.parse(widthConfig.viewModel[0].fdConfig);
    parentOf(view.view.render.desktop[0], "fd_total60").controlProps.style.width = "60px";
    widthConfig.viewModel[0].fdConfig = JSON.stringify(view);
    widthLost.mechanisms["sys-xform"].fdConfig = JSON.stringify(widthConfig);
    assert.equal(prepared.verify(widthLost).ok, false);
    const styleLost = structuredClone(prepared.update), styleConfig = xformConfig(styleLost);
    const styled = JSON.parse(styleConfig.viewModel[0].fdConfig);
    delete styled.controlStyle.fd_total60;
    styleConfig.viewModel[0].fdConfig = JSON.stringify(styled);
    styleLost.mechanisms["sys-xform"].fdConfig = JSON.stringify(styleConfig);
    assert.equal(prepared.verify(styleLost).ok, false);
    const decorated = structuredClone(prepared.update), decoratedConfig = xformConfig(decorated);
    const amount = decoratedConfig.dataModel[0].fdFields.find(f => JSON.parse(f.fdAttribute).config.controlProps.name === "fd_total60");
    const attribute = JSON.parse(amount.fdAttribute);
    attribute.config.controlProps.unit = "kg";
    amount.fdAttribute = JSON.stringify(attribute);
    decorated.mechanisms["sys-xform"].fdConfig = JSON.stringify(decoratedConfig);
    assert.equal(prepared.verify(decorated).ok, false);
  });

  for (const [name, replacement] of [
    ["unknown JSP condition", `<% if(flag) { %>${runtimeTag}<% } %>`],
    ["known readonly condition around the candidate", `<%if ("readOnly".equals(request.getAttribute("SysForm.base.showStatus"))) {%>${runtimeTag}<%}%>`],
    ["JSP output wrapper", `<% out.write("<div style='width:20px'>"); %>${runtimeTag}<% out.write("</div>"); %>`],
    ["nonlocal JSP mutation", `<% changeLayout(); %>${runtimeTag}`],
    ["unknown JSP include", `<%@ include file="unknown.jsp"%>${runtimeTag}`],
    ["unknown literal status", runtimeTag.replace("/>", ' showStatus="mystery-mode"/>')],
    ["unknown dynamic status", runtimeTag.replace("/>", ' showStatus="${unknownMode}"/>')],
    ["hidden status", runtimeTag.replace("/>", ' showStatus="noShow"/>')],
    ["redefined xform namespace", `<%@ taglib prefix="xform" uri="urn:alternative-renderer"%>${runtimeTag}`],
    ["uncertain ancestor attributes", `<div class="one" class="two">${runtimeTag}</div>`],
    ["uncertain possible field binding", `<img property="extendDataFormInfo.value(fd_total60)" alt="one" alt="two"/>${runtimeTag}`],
    ["missing runtime binding", ""],
    ["duplicate runtime binding", runtimeTag + runtimeTag],
    ["duplicate other runtime renderer", runtimeTag + runtimeTag.replace("xform:xtext", "xform:text")],
    ["duplicate noncanonical main binding", runtimeTag + runtimeTag.replace("value(fd_total60)", "value( fd_total60 )")],
    ["noncanonical binding", runtimeTag.replace("value(fd_total60)", "value( fd_total60 )")],
    ["detail binding", runtimeTag.replace("value(fd_total60)", "value(rows.0.fd_total60)")],
    ["nonselfclosing xtext", runtimeTag.replace("/>", "></xform:xtext>")],
    ["different renderer", runtimeTag.replace("xform:xtext", "xform:text")],
    ["missing readonly", runtimeTag.replace('htmlElementProperties="readonly"', 'htmlElementProperties=""')],
    ["runtime readonly false", runtimeTag.replace('htmlElementProperties="readonly"', 'htmlElementProperties="readonly=\'false\'"')],
    ["explicit runtime label", runtimeTag.replace("/>", ' showLabel="true"/>')],
    ["uncertain runtime label", runtimeTag.replace("/>", ' showLabel="${labelFlag}"/>')],
    ["inner property style override", runtimeTag.replace('htmlElementProperties="readonly"', 'htmlElementProperties="readonly style=\'width:20px\'"')],
    ["duplicate property", runtimeTag.replace("/>", ' property="extendDataFormInfo.value(fd_total60)"/>')],
    ["runtime width mismatch", runtimeTag.replace("60px", "61px")],
    ["unsupported width", runtimeTag.replace("60px", "auto")],
    ["percentage width", runtimeTag.replace("60px", "60%")],
    ["duplicate CSS width", runtimeTag.replace("60px;", "60px;width:60px;")],
    ["uncertain CSS", runtimeTag.replace("WIDTH:", "/* sizing */WIDTH:")],
    ["sized non-table ancestor", `<div style="width:200px">${runtimeTag}</div>`],
    ["script sample", `<script>const s='${runtimeTag}';</script>`],
    ["style sample", `<style>${runtimeTag}</style>`],
    ["textarea sample", `<textarea>${runtimeTag}</textarea>`],
    ["HTML comment", `<!-- ${runtimeTag} -->`],
    ["JSP comment", `<%-- ${runtimeTag} --%>`],
    ["executable JSP sample", `<% String sample = '${runtimeTag}'; %>`],
    ["unclosed script", `<script>${runtimeTag}`],
    ["unclosed JSP", `<% String sample = '${runtimeTag}';`]
  ]) {
    it(`does not acquire display authority from ${name}`, () => {
      const changed = xml.replace(escapeXml(runtimeTag), escapeXml(replacement));
      const raw = sourceFromXml(changed).form.controls.find(f => f.id === "fd_total60");
      assert.equal(raw.sourceProps[prop], undefined);
    });
  }

  for (const [name, from, to] of [
    ["missing metadata", '<extendSimpleProperty name="fd_total60" label="Total sixty" type="Double" scale="2" defaultValue="0"/>', ""],
    ["duplicate metadata", '<extendSimpleProperty name="fd_total60" label="Total sixty" type="Double" scale="2" defaultValue="0"/>', '<extendSimpleProperty name="fd_total60" label="Total sixty" type="Double" scale="2" defaultValue="0"/><extendSimpleProperty name="fd_total60" label="Other" type="Double"/>'],
    ["conflicting metadata type", 'name="fd_total60" label="Total sixty" type="Double"', 'name="fd_total60" label="Total sixty" type="String"'],
    ["conflicting metadata width", 'name="fd_total60" label="Total sixty" type="Double"', 'name="fd_total60" label="Total sixty" width="61" type="Double"'],
    ["conflicting source flow width", 'style="WIDTH: 60px;DISPLAY:inline" fd_type="calculation"', 'style="WIDTH: 70px;DISPLAY:inline" fd_type="calculation"'],
    ["source permission editable", 'id:"fd_total60",label:"Total sixty",dataType:"Double",width:"60",readOnly:"true"', 'id:"fd_total60",label:"Total sixty",dataType:"Double",width:"60",readOnly:"false"'],
    ["source prefix decoration", 'id:"fd_total60",label:', 'id:"fd_total60",prefix:"currency",label:']
  ]) {
    it(`does not budget an unsupported source profile: ${name}`, () => {
      const changed = xml.replace(escapeXml(from), escapeXml(to));
      const raw = sourceFromXml(changed).form.controls.find(f => f.id === "fd_total60");
      assert.equal(raw.sourceProps[prop], undefined);
    });
  }

  it("does not let an unrelated malformed void icon poison a unique later field", () => {
    const changed = xml.replace(escapeXml(runtimeTag), escapeXml('<img alt="one" alt="two"/>' + runtimeTag));
    assert.equal(sourceNumberDisplays(sourceFromXml(changed).form).has("fd_total60"), true);
  });

  it("admits only canonical platform status expressions and unrelated namespace declarations", () => {
    for (const status of ["${requestScope['SysForm.showStatus']}", '${requestScope["SysForm.showStatus"]}']) {
      const quote = status.includes('"') ? "'" : '"';
      const tag = runtimeTag.replace("/>", ` showStatus=${quote}${status}${quote}/>`);
      const changed = xml.replace(escapeXml(runtimeTag), escapeXml('<%@ taglib prefix="ext" uri="urn:extra"%>' + tag));
      assert.equal(sourceNumberDisplays(sourceFromXml(changed).form).has("fd_total60"), true);
    }
  });

  it("keeps a detail binding in its own scope while requiring a unique canonical main renderer", () => {
    const changed = xml.replace(escapeXml(runtimeTag), escapeXml(runtimeTag + runtimeTag.replace("value(fd_total60)", "value(rows.0.fd_total60)")));
    const source = sourceFromXml(changed);
    assert.equal(sourceNumberDisplays(source.form).has("fd_total60"), true);
  });

  it("uses only the existing readonly library island and preserves unrelated self-closing taglib controls", () => {
    const header = '<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%><%@ include file="/resource/jsp/common.jsp"%>';
    const island = '<%if ("readOnly".equals(request.getAttribute("SysForm.base.showStatus"))) {%><script>Com_IncludeFile("calculation_script.js", "../sys/xform/designer/calculation/");</script><%}%>';
    const tag = runtimeTag.replace("/>", ' dataType="Double" editReadonlyStyle="inputsgl" isLoadDataDict="false" subject="Total" title="Total"/>');
    const changed = xml.replace(escapeXml(runtimeTag), escapeXml(header + island + tag + '<xform:textarea property="extendDataFormInfo.value(unrelated)"/>'));
    const source = sourceFromXml(changed);
    assert.equal(source.form.controls.find(f => f.id === "fd_total60").sourceProps[prop].valuePx, 60);
    assert.equal(sourceNumberDisplays(source.form).has("fd_total60"), true);
  });

  it("does not admit native unit decoration while preserving proven external unit text", () => {
    const { source, draft } = stages();
    assert.equal(sourceNumberDisplays(source.form).has("fd_total60"), true);
    assert.equal(sourceNumberDisplays(draft.form).has("fd_total60"), true);
    for (const change of [f => { f.props.unit = "kg"; }, f => { f.props.numberFormat = { unit: "kg" }; }, f => { f.sourceProps.designerValues.unit = "kg"; }]) {
      const candidate = structuredClone(draft); change(field(candidate, "fd_total60"));
      assert.equal(sourceNumberDisplays(candidate.form).has("fd_total60"), false);
    }
  });

  for (const [name, change] of [
    ["evidence deleted", f => { delete f.sourceProps[prop]; }],
    ["runtime width forged", f => { f.sourceProps[prop] = { ...f.sourceProps[prop], valuePx: 90 }; }],
    ["source width forged", f => { f.sourceProps.designerValues.width = "90"; }],
    ["readonly removed", f => { delete f.props.readOnly; }],
    ["hidden label removed", f => { delete f.props.hiddenLabel; }],
    ["calculation removed", f => { delete f.props.calculation; }],
    ["precision changed", f => { f.props.precision = 0; }],
    ["native unit invented", f => { f.props.unit = "kg"; }],
    ["nested format unit invented", f => { f.props.numberFormat = { unit: "kg" }; }],
    ["source unit invented", f => { f.sourceProps.designerValues.unit = "kg"; }],
    ["component changed", f => { f.componentId = "xform-number"; }]
  ]) {
    it(`binds a genuine trusted baseline and rejects ${name}`, () => {
      const { source, trusted } = trustedStages();
      change(field(trusted, "fd_total60"));
      const result = checkTrust(source, trusted);
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some(d => d.code === "trust.form.number_display_source_mismatch"), JSON.stringify(result.diagnostics));
    });
  }

  it("does not let a candidate invent hidden-label source evidence to enter the policy", () => {
    const { source, trusted } = trustedStages();
    const visible = field(trusted, "fd_visible_total"), actual = field(trusted, "fd_total100");
    visible.sourceProps[prop] = { ...actual.sourceProps[prop], property: "extendDataFormInfo.value(fd_visible_total)" };
    visible.sourceProps.layoutCell = { hiddenLabel: true, relation: "independent-bound-title-cell", captionIds: ["invented"] };
    visible.props.hiddenLabel = true;
    const result = checkTrust(source, trusted);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(d => d.code === "trust.form.number_display_source_mismatch"), JSON.stringify(result.diagnostics));
  });
});

function escapeXml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function parentOf(node, id) {
  if (node.children?.some(child => child.key === id)) return node;
  for (const child of node.children || []) {
    const found = parentOf(child, id);
    if (found) return found;
  }
}
