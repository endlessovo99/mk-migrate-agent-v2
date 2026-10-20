import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile } from "../../src/translator/index.js";
// Preserve the retained source-width contract explicitly.
import { draftSourceDraft } from "../helpers/source-sized-draft.js";
import { translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { renderNativeFieldReferences } from "../helpers/native-form-renderer.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/designer-select-face-width/select-face_SysFormTemplate.xml";
const xml = readFileSync(fixture, "utf8");
const runtimeTag = '<xform:select property="extendDataFormInfo.value(fd_face)"/>';

describe("designer select face width Route-validation", () => {
  it("removes only the decorated face width and keeps explicit widths and cell order", () => {
    const source = cleanSourceFile(fixture);
    const cell = source.form.layout.rows[0].cells[0];
    assert.deepEqual(cell.contentFlow.lines, [
      ["fd_face", "fd_values"], ["fd_runtime", "fd_plain", "fd_text", "fd_note"]
    ]);
    assert.deepEqual(cell.contentFlow.items, [
      { referenceId: "fd_face" },
      { referenceId: "fd_values", width: { value: 240, unit: "px" } },
      { referenceId: "fd_runtime", width: { value: 40, unit: "%" } },
      { referenceId: "fd_plain", width: { value: 130, unit: "px" } },
      { referenceId: "fd_text", width: { value: 160, unit: "px" } },
      { referenceId: "fd_note", width: { value: 75, unit: "px" } }
    ]);
    const draft = draftSourceDraft(source);
    assert.equal(checkDraft(draft).ok, true);
    assert.equal(source.form.controls.find((field) => field.id === "fd_values").sourceProps.designerValues.width, "240");
    assert.equal(draft.form.fields.find((field) => field.id === "fd_face").props.options[0].label,
      "A long complete option label for the selected value");
  });

  it("projects no fixed face width in desktop and mobile without changing writer flex defaults", () => {
    const prepared = prepareSample(draftSourceDraft(cleanSourceFile(fixture)));
    assert.equal(prepared.verify(prepared.update).ok, true);
    const config = xformConfig(prepared.update);
    const view = JSON.parse(config.viewModel[0].fdConfig);
    for (const scene of ["desktop", "mobile"]) {
      const root = view.view.render[scene][0];
      assert.deepEqual(parentOf(root, "fd_face").controlProps.style, {
        flex: "0 1 auto", minWidth: 0, maxWidth: "100%", overflow: "visible"
      });
      assert.equal(parentOf(root, "fd_values").controlProps.style.width, "240px");
      assert.equal(parentOf(root, "fd_runtime").controlProps.style.width, "40%");
      const rendered = renderNativeFieldReferences(config, scene);
      assert.deepEqual(rendered.actual, rendered.expected);
    }
  });

  for (const [name, replacement] of [
    ["missing runtime field", ""],
    ["another runtime field", runtimeTag.replace("fd_face", "fd_unrelated")],
    ["duplicate runtime binding", runtimeTag + runtimeTag],
    ["conflicting runtime widths", runtimeTag.replace("/>", ' width="200"/>') + runtimeTag.replace("/>", ' width="300"/>')],
    ["runtime wrapper width", `<div style="width:300px">${runtimeTag}</div>`],
    ["runtime wrapper expression", `<span style="width:calc(100% - 10px)">${runtimeTag}</span>`],
    ["script text is not a runtime field", `<script>const sample = '${runtimeTag}';</script>`],
    ["detail binding is not a main field", runtimeTag.replace("value(fd_face)", "value(fd_rows.0.fd_face)")]
  ]) {
    it(`retains the previous width when ${name} does not prove a widthless runtime select`, () => {
      assert.deepEqual(widthFor(replaceRuntime(xml, replacement)), { value: 101, unit: "px" });
    });
  }

  for (const width of ["auto", "calc(100% - 10px)", "-1px", "var(--size)", "expression(alert(1))", ""]) {
    it(`does not treat an unsupported runtime width ${JSON.stringify(width)} as absent`, () => {
      const changed = replaceRuntime(xml, runtimeTag.replace("/>", ` style="width:${width}"/>`));
      assert.deepEqual(widthFor(changed), { value: 101, unit: "px" });
    });
  }

  for (const style of [
    "/* sizing */ width:240px",
    "width/* sizing */:240px",
    "width:240px; /* unknown override */",
    "w\\69dth:240px",
    "${computedStyle}",
    "width 240px"
  ]) {
    it(`keeps the previous width when runtime CSS cannot be proved: ${style}`, () => {
      const changed = replaceRuntime(xml, runtimeTag.replace("/>", ` style="${style}"/>`));
      assert.deepEqual(widthFor(changed), { value: 101, unit: "px" });
    });
  }

  it("treats uncertain width on an outer runtime container conservatively", () => {
    const changed = replaceRuntime(xml, `<div style="/* sizing */ width:240px">${runtimeTag}</div>`);
    assert.deepEqual(widthFor(changed), { value: 101, unit: "px" });
  });

  for (const comment of [
    `<%-- ignored > ${runtimeTag} --%>`,
    `<%-- unfinished > ${runtimeTag}`
  ]) {
    it(`does not use a JSP-commented select as runtime evidence: ${comment}`, () => {
      assert.deepEqual(widthFor(replaceRuntime(xml, comment)), { value: 101, unit: "px" });
    });
  }

  it("ignores a commented duplicate while preserving real runtime evidence and unrelated styles", () => {
    const changed = replaceRuntime(xml, `<%-- ignored > ${runtimeTag} --%>` +
      runtimeTag.replace("/>", ' style="display:inline;color:red"/>'));
    assert.equal(widthFor(changed), undefined);
  });

  it("preserves valid runtime width ahead of conflicting designer values without changing the evidence", () => {
    const changed = replaceRuntime(xml, runtimeTag.replace("/>", ' width="55%"/>'))
      .replace('id:"fd_face",label:"Automatic",dataType:"String",', 'id:"fd_face",label:"Automatic",dataType:"String",width:"240",');
    const form = translateSysFormTemplateXml(changed).form;
    assert.deepEqual(flowWidth(form, "fd_face"), { value: 55, unit: "%" });
    assert.equal(form.fields.find((field) => field.id === "fd_face").source.designerValues.width, "240");
  });

  for (const value of ["0", "75.5px", "60%"]) {
    it(`preserves declared width ${value} instead of a decorative face width`, () => {
      const changed = xml.replace('id:"fd_face",label:"Automatic",dataType:"String",',
        `id:"fd_face",label:"Automatic",dataType:"String",width:"${value}",`);
      assert.deepEqual(widthFor(changed), { value: parseFloat(value), unit: value.endsWith("%") ? "%" : "px" });
    });
  }

  for (const [name, from, to] of [
    ["ordinary select", 'class="select_div_box"', 'class="ordinary"'],
    ["missing face", 'class="select_tag_face"', 'class="ordinary_face"'],
    ["visible native select", 'style="DISPLAY:none"', 'style="DISPLAY:inline"'],
    ["non-select control", 'fd_type="select"', 'fd_type="inputText"']
  ]) {
    it(`keeps explicit width for ${name}`, () => {
      assert.deepEqual(widthFor(xml.replace(escapeXml(from), escapeXml(to))), { value: 101, unit: "px" });
    });
  }

  it("does not inherit a hidden native select width or the containing TD width", () => {
    const changed = xml.replace('style="DISPLAY:none"', 'style="DISPLAY:none;width:200px"');
    assert.equal(widthFor(changed), undefined);
  });

  it("does not carry a sibling wrapper width into the next runtime select", () => {
    const changed = replaceRuntime(xml, `<div style="width:300px"><xform:select property="extendDataFormInfo.value(unrelated)"/></div>${runtimeTag}`);
    assert.equal(widthFor(changed), undefined);
  });

  it("keeps a main-field binding distinct from a detail-column binding with the same suffix", () => {
    const changed = replaceRuntime(xml, runtimeTag + runtimeTag.replace("value(fd_face)", "value(fd_rows.0.fd_face)"));
    assert.equal(widthFor(changed), undefined);
  });

  it("supports the inputSelect alias only with the same decorated shape and runtime evidence", () => {
    assert.equal(widthFor(xml.replace('fd_type="select"', 'fd_type="inputSelect"')), undefined);
  });

  it("preserves an unsupported declared width instead of assuming it is absent", () => {
    const changed = xml.replace('id:"fd_face",label:"Automatic",dataType:"String",',
      'id:"fd_face",label:"Automatic",dataType:"String",width:"calc(100% - 2px)",');
    assert.deepEqual(widthFor(changed), { value: 101, unit: "px" });
  });

  it("uses the final runtime style width before its width attribute", () => {
    const changed = replaceRuntime(xml, runtimeTag.replace("/>", ' width="500" style="width:80px;WIDTH:30%"/>'));
    assert.deepEqual(widthFor(changed), { value: 30, unit: "%" });
  });

  it("uses the same structure after source field ids and labels change", () => {
    const changed = xml.replaceAll("fd_face", "renamed_choice").replaceAll("Automatic", "New label");
    assert.equal(flowWidth(translateSysFormTemplateXml(changed).form, "renamed_choice"), undefined);
  });

  it("passes review, trust, dry-run and executor readback using fake clients", async () => {
    const result = await runRouteCase("designer-select-face-width-success");
    assert.equal(result.dsl.trust.executable, true);
    assert.equal(result.dryRun.ok, true);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.readback.ok, true);
  });
});

function widthFor(source) {
  return flowWidth(translateSysFormTemplateXml(source).form, "fd_face");
}

function flowWidth(form, id) {
  return form.layout.rows.flatMap((row) => row.cells)
    .flatMap((cell) => cell.contentFlow?.items || []).find((item) => item.referenceId === id)?.width;
}

function replaceRuntime(source, replacement) {
  return source.replace(escapeXml(runtimeTag), escapeXml(replacement));
}

function escapeXml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function parentOf(node, fieldId) {
  if (node.children?.some((child) => child.key === fieldId)) return node;
  for (const child of node.children || []) {
    const found = parentOf(child, fieldId);
    if (found) return found;
  }
}
