import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { renderNativeFieldReferences } from "../helpers/native-form-renderer.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/designer-checkbox-width/checkbox-width_SysFormTemplate.xml";
const xml = readFileSync(fixture, "utf8");
const runtimeTag = '<xform:checkbox property="extendDataFormInfo.value(fd_vertical)" alignment="V"/>';
const previousWidth = { value: 108, unit: "px" };

describe("designer checkbox placeholder width Route-validation", () => {
  it("reviews and executes the unconstrained checkbox through native readback and recording", async () => {
    const result = await runRouteCase("designer-checkbox-width-success");
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.transferRecord.status, "recorded");
  });
  it("removes only proven placeholder widths while preserving directions, options and physical order", () => {
    const source = cleanSourceFile(fixture);
    const cell = source.form.layout.rows[0].cells[0];
    assert.deepEqual(cell.contentFlow.lines, [["fd_vertical"], ["fd_horizontal"]]);
    assert.deepEqual(cell.contentFlow.items, [{ referenceId: "fd_vertical" }, { referenceId: "fd_horizontal" }]);
    const dsl = draftSourceDraft(source);
    assert.equal(checkDraft(dsl).ok, true);
    for (const [id, alignment] of [["fd_vertical", "V"], ["fd_horizontal", "H"]]) {
      const field = dsl.form.fields.find(f => f.id === id);
      assert.equal(field.componentId, "xform-checkbox");
      assert.equal(field.sourceProps.designerValues.alignment, alignment);
      assert.equal(Object.hasOwn(field.sourceProps.designerValues, "width"), false);
      assert.deepEqual(field.props.options, [
        { label: "Projector", value: "projector" },
        { label: "Wireless microphone", value: "microphone" },
        { label: "Meeting connection", value: "meeting" }
      ]);
    }
  });

  it("projects no fixed placeholder width while preserving source checkbox option rows", () => {
    const prepared = prepareSample(draftSourceDraft(cleanSourceFile(fixture)));
    const config = xformConfig(prepared.update);
    assert.equal(prepared.verify(prepared.update).ok, true);
    const view = JSON.parse(config.viewModel[0].fdConfig);
    for (const scene of ["desktop", "mobile"]) {
      const root = view.view.render[scene][0];
      for (const id of ["fd_vertical", "fd_horizontal"]) {
        assert.deepEqual(parentOf(root, id).controlProps.style, {
          flex: "0 1 auto", minWidth: 0, maxWidth: "100%", overflow: "visible"
        });
      }
      const rendered = renderNativeFieldReferences(config, scene);
      assert.deepEqual(rendered.actual, rendered.expected);
    }
    const fields = config.dataModel.find(m => m.fdType === "main").fdFields;
    const vertical = JSON.parse(fields.find(f => f.fdName === "fd_vertical").fdAttribute).config.controlProps;
    const horizontal = JSON.parse(fields.find(f => f.fdName === "fd_horizontal").fdAttribute).config.controlProps;
    assert.equal(vertical.direction, "row");
    assert.equal(vertical.rowCount, 1);
    assert.equal(horizontal.direction, "column");
    assert.equal(horizontal.rowCount, 3);
    assert.deepEqual(vertical.options, horizontal.options);
  });

  for (const [name, replacement] of [
    ["missing binding", ""],
    ["another field", runtimeTag.replace("fd_vertical", "unrelated")],
    ["duplicate binding", runtimeTag + runtimeTag],
    ["conflicting binding widths", runtimeTag + runtimeTag.replace("/>", ' width="300"/>')],
    ["sized non-table ancestor", `<div style="width:300px">${runtimeTag}</div>`],
    ["sized non-table attribute", `<span width="300">${runtimeTag}</span>`],
    ["unsupported ancestor width", `<span style="width:auto">${runtimeTag}</span>`],
    ["uncertain ancestor CSS", `<span style="/* sizing */width:300px">${runtimeTag}</span>`],
    ["script sample", `<script>const sample='${runtimeTag}';</script>`],
    ["style sample", `<style>${runtimeTag}</style>`],
    ["JSP comment", `<%-- ${runtimeTag} --%>`],
    ["detail binding", runtimeTag.replace("value(fd_vertical)", "value(rows.0.fd_vertical)")],
    ["noncanonical property", runtimeTag.replace("value(fd_vertical)", "value( fd_vertical )")],
    ["different runtime control type", runtimeTag.replace("xform:checkbox", "xform:radio")]
  ]) {
    it(`keeps the previous width for ${name}`, () => {
      assert.deepEqual(widthFor(replaceRuntime(xml, replacement)), previousWidth);
    });
  }

  for (const width of ["180", "40%", "auto", "calc(100% - 10px)", "-1px", "", "var(--size)"]) {
    it(`preserves the previous width when runtime declares ${JSON.stringify(width)}`, () => {
      assert.deepEqual(widthFor(replaceRuntime(xml, runtimeTag.replace("/>", ` style="width:${width}"/>`))), previousWidth);
    });
  }

  for (const width of ["180", "", "calc(100% - 10px)"]) {
    it(`does not remove explicit source width ${JSON.stringify(width)}`, () => {
      const changed = xml.replace('id:"fd_vertical",label:', `id:"fd_vertical",width:"${width}",label:`);
      assert.deepEqual(widthFor(changed), previousWidth);
      assert.equal(translateSysFormTemplateXml(changed).form.fields.find(f => f.id === "fd_vertical").source.designerValues.width, width);
    });
  }

  for (const [name, from, to] of [
    ["ordinary control", 'fd_type="inputCheckbox"', 'fd_type="inputText"'],
    ["non-placeholder class", 'class="tb_noborder"', 'class="ordinary"'],
    ["non-checkbox inner input", 'type="checkbox"', 'type="radio"'],
    ["mismatched inner binding", 'id="fd_vertical"', 'id="unrelated"']
  ]) {
    it(`retains the previous width for ${name}`, () => {
      assert.deepEqual(widthFor(xml.replace(escapeXml(from), escapeXml(to))), previousWidth);
    });
  }

  it("does not carry a sibling container width into the actual binding", () => {
    const replacement = '<div style="width:300px"><xform:checkbox property="extendDataFormInfo.value(unrelated)"/></div>' + runtimeTag;
    assert.equal(widthFor(replaceRuntime(xml, replacement)), undefined);
  });

  it("ignores commented duplicates and detail fields sharing only the suffix", () => {
    const replacement = `<%-- ${runtimeTag} --%>` + runtimeTag + runtimeTag.replace("value(fd_vertical)", "value(rows.0.fd_vertical)");
    assert.equal(widthFor(replaceRuntime(xml, replacement)), undefined);
  });

  it("uses the same evidence after source field ids and labels change", () => {
    const changed = xml.replaceAll("fd_vertical", "renamed_support").replaceAll("Vertical support", "Other support");
    assert.equal(flowWidth(translateSysFormTemplateXml(changed).form, "renamed_support"), undefined);
  });
});

function widthFor(source) {
  return flowWidth(translateSysFormTemplateXml(source).form, "fd_vertical");
}
function flowWidth(form, id) {
  return form.layout.rows.flatMap(row => row.cells).flatMap(cell => cell.contentFlow?.items || []).find(item => item.referenceId === id)?.width;
}
function replaceRuntime(source, replacement) {
  return source.replace(escapeXml(runtimeTag), escapeXml(replacement));
}
function escapeXml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function parentOf(node, fieldId) {
  if (node.children?.some(child => child.key === fieldId)) return node;
  for (const child of node.children || []) {
    const found = parentOf(child, fieldId);
    if (found) return found;
  }
}
