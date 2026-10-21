import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";
import { cleanSourceWithoutCaptionFact } from "../helpers/retained-caption-source.js";

const fixture = "tests/fixtures/route-validation/native-caption-fold/plain_SysFormTemplate.xml";
const xml = readFileSync(fixture, "utf8");
const subjectId = "fd_department";
const captionId = "caption_department";
const field = (dsl, id) => dsl.form.fields.find(item => item.id === id);
const runtimeTable = '<TABLE id="table_caption"><TBODY><TR><TD class="td_normal_title" row="0" column="0">' +
  '<LABEL>申请部门</LABEL></TD><TD row="0" column="1">' +
  '<xform:xtext property="extendDataFormInfo.value(fd_department)"/></TD></TR></TBODY></TABLE>';

it("passes review, fake execution and readback with one native field title", async () => {
  const result = await runRouteCase("native-caption-fold-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.transferRecord.status, "recorded");
  assert.equal(field(result.dsl, captionId), undefined);
  assert.equal(field(result.dsl, subjectId).title, "申请部门");
  assert.notEqual(field(result.dsl, subjectId).props.hiddenLabel, true);
});

it("uses script evidence after the same complete runtime row proves the caption", () => {
  const base = variant(props => { props.fdDisplayJsp = runtimeTable; });
  assert.equal(field(base.draft, captionId), undefined);
  for (const javascript of [
    'var k="caption_";hideCaption(k + "department");',
    'var k="department";globalThis["document"].getElementById("caption_" + k).style.display="none";'
  ]) {
    const { source, draft } = variant(props => { props.fdDisplayJsp = runtimeTable + `<script>${javascript}</script>`; });
    assert.equal(source.form.controls.find(item => item.id === captionId).sourceProps.staticCaptionFact?.plainText, true);
    assert.ok(source.scripts.sources.some(item => item.javascript.includes(javascript)));
    assertRetained(draft);
  }
});

for (const [path, expectedOwners] of [
  ["mobile-plain-caption/mobile-plain-caption_SysFormTemplate.xml", ["fd_department", "fd_reason", "fd_choice"]],
  ["mobile-caption-last-body/canonical-body-kinds_SysFormTemplate.xml", ["fd_rich", "fd_select", "fd_files"]],
  ["native-field-width/amount-caption_SysFormTemplate.xml", ["fd_amount"]]
]) it(`fresh XML folds native titles while retained artifacts keep independent captions: ${path}`, () => {
  const file = `tests/fixtures/route-validation/${path}`;
  const source = cleanSourceFile(file), draft = draftSourceDraft(source);
  const retainedSource = cleanSourceWithoutCaptionFact(file), retained = draftSourceDraft(retainedSource);
  for (const id of expectedOwners) {
    const folded = field(draft, id), previous = field(retained, id), caption = folded.sourceProps.foldedCaption;
    assert.ok(caption, id);
    assert.equal(field(retained, caption.id)?.componentId, "xform-description");
    assert.equal(field(draft, caption.id), undefined);
    assert.equal(folded.id, previous.id);
    assert.equal(folded.type, previous.type);
    assert.equal(folded.componentId, previous.componentId);
    const { hiddenLabel: _hidden, ...previousProps } = previous.props;
    assert.deepEqual(folded.props, previousProps);
    assert.equal(folded.title, caption.content);
    assert.deepEqual(draft.form.layout.mkTree.flatMap(row => row.children)
      .find(cell => cell.refIds?.includes(id)).contentFlow,
    retained.form.layout.mkTree.flatMap(row => row.children).find(cell => cell.refIds?.includes(id)).contentFlow);
  }
  assert.deepEqual(draft.form.layout.sourceGrid, retained.form.layout.sourceGrid);
  for (const [facts, candidate] of [[source, draft], [retainedSource, retained]]) {
    assertTrusted(facts, candidate);
    const prepared = prepareSample(candidate);
    assert.equal(prepared.verify(prepared.update).ok, true);
  }
});

function stages(sourceXml) {
  const source = sourceXml === undefined ? cleanSourceFile(fixture) : sourceFromXml(sourceXml);
  return { source, draft: draftSourceDraft(source) };
}

function sourceFromXml(text) {
  const directory = mkdtempSync(join(tmpdir(), "native-caption-fold-"));
  try {
    const path = join(directory, "native-caption-fold_SysFormTemplate.xml");
    writeFileSync(path, text);
    return cleanSourceFile(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function trusted(source, draft) {
  return createTrustedMigrationDsl(source, draft, {
    externalAgentReviewed: true,
    reviewerName: "synthetic native caption fold regression",
    checkedAt: "2026-10-20T00:00:00Z"
  });
}

const encode = text => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function variant(change) {
  const props = parseRootHashMapStringPuts(xml), before = structuredClone(props);
  change(props);
  assert.notDeepEqual(props, before, "The source counterexample must actually change the XML");
  return stages('<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
    Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") +
    "</object></java>");
}

function assertTrusted(source, draft) {
  const checked = checkTrust(source, trusted(source, draft));
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
}

function assertRetained(draft) {
  assert.equal(field(draft, captionId)?.componentId, "xform-description");
  assert.equal(field(draft, captionId)?.props.content, "申请部门");
  assert.equal(field(draft, subjectId)?.props.hiddenLabel, true);
  assert.ok(draft.form.layout.mkTree.some(row =>
    row.children?.some(cell => cell.refIds?.includes(captionId))), "The retained caption must remain rendered");
}

it("folds a unique plain bound title into its original input and merges its occupied cells", () => {
  const { source, draft } = stages();
  const original = source.form.controls.find(item => item.id === subjectId);
  assert.equal(original.sourceProps.layoutCell.hiddenLabel, true, "The fixture exercises a formerly independent title");
  assert.deepEqual(draft.form.fields.map(item => item.id), [subjectId]);
  const subject = field(draft, subjectId);
  assert.equal(subject.title, "申请部门");
  assert.equal(subject.componentId, "xform-input");
  assert.notEqual(subject.props.hiddenLabel, true);
  assert.equal(subject.props.required, true);
  assert.equal(subject.props.readOnly, true);
  assert.deepEqual(subject.props.defaultValue, { kind: "literal", value: "运营部" });
  const cells = draft.form.layout.mkTree.flatMap(row => row.children || []);
  assert.equal(cells.length, 1, "Deleting the caption must not leave an empty layout cell");
  assert.deepEqual(cells[0].refIds, [subjectId]);
  assert.equal(cells[0].colspan, 2);

  assertTrusted(source, draft);
  const prepared = prepareSample(draft), config = xformConfig(prepared.update);
  const nativeFields = config.dataModel[0].fdFields.map(item => JSON.parse(item.fdAttribute).config);
  const native = nativeFields.find(item => item.controlProps.name === subjectId);
  assert.equal(native.label, "申请部门");
  assert.equal(native.controlProps.title, "申请部门");
  for (const scene of ["desktop", "mobile"]) {
    assert.notEqual(native.controlProps[scene]?.hiddenLabel, true);
    assert.notEqual(native.labelProps[scene]?.hiddenLabel, true);
  }
  assert.equal(nativeFields.some(item => item.controlProps.name === captionId), false);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

for (const [name, designerType, componentId] of [
  ["textarea", "textarea", "xform-textarea"],
  ["select", "inputSelect", "xform-select"]
]) it(`folds the same one-to-one title for a ${name} without changing the field identity`, () => {
  const { source, draft } = variant(props => {
    props.fdDesignerHtml = props.fdDesignerHtml
      .replace('fd_type="inputText"', `fd_type="${designerType}"`)
      .replace('dataType:"String"', 'items:"运营部|运营部\\r\\n财务部|财务部",dataType:"String"');
  });
  assert.deepEqual(draft.form.fields.map(item => item.id), [subjectId]);
  assert.equal(field(draft, subjectId).componentId, componentId);
  assert.equal(field(draft, subjectId).title, "申请部门");
  assert.notEqual(field(draft, subjectId).props.hiddenLabel, true);
  assert.equal(field(draft, subjectId).props.required, true);
  assert.equal(field(draft, subjectId).props.readOnly, true);
  assertTrusted(source, draft);
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("folds a stale designer binding only when the runtime uniquely proves its visible title", () => {
  const { source, draft } = variant(props => {
    props.fdDesignerHtml = props.fdDesignerHtml
      .replace('fd_type="inputText"', 'fd_type="inputText" style="width:120px;display:inline"')
      .replace('dataType:"String"', 'width:"120",dataType:"String"')
      .replace('id="fd_department" type=', 'id="fd_department" style="width:120px;display:inline" type=')
      .replace('_label_bind_id:"caption_department"', '_label_bind_id:"missing_old_caption"');
    props.fdDisplayJsp = '<TABLE id="table_caption"><TR><TD class="td_normal_title" row="0" column="0">' +
      '<LABEL id="caption_department">申请部门</LABEL></TD><TD row="0" column="1">' +
      '<xform:xtext property="extendDataFormInfo.value(fd_department)" style="width:120px;display:inline" htmlElementProperties="readonly"/>' +
      '</TD></TR></TABLE>';
  });
  assert.equal(source.form.controls.find(item => item.id === subjectId)?.sourceProps.layoutCell?.relation,
    "runtime-independent-title-cell", "The test must use a real runtime ownership proof");
  assert.deepEqual(draft.form.fields.map(item => item.id), [subjectId]);
  assert.equal(field(draft, subjectId).title, "申请部门");
  assert.notEqual(field(draft, subjectId).props.hiddenLabel, true);
  assertTrusted(source, draft);
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("preserves the source grid, unrelated cells and original input width while merging only its title region", () => {
  const { source, draft } = variant(props => {
    props.fdDesignerHtml = props.fdDesignerHtml
      .replace('column="0"', 'column="0" width="160"')
      .replace('column="1"', 'column="1" width="400"')
      .replace('fd_type="inputText"', 'fd_type="inputText" style="width:120px;display:inline"')
      .replace('dataType:"String"', 'width:"120",dataType:"String"')
      .replace("</TR>", '<TD row="0" column="2" width="80"><LABEL fd_type="textLabel" fd_values=\'{id:"other_note",content:"其他说明",b:"true"}\'>其他说明</LABEL></TD>' +
        '<TD row="0" column="3" width="200"><DIV fd_type="inputText" fd_values=\'{id:"fd_other",label:"Other",dataType:"String",_label_bind:"false"}\'><INPUT id="fd_other"/></DIV></TD></TR>');
    props.fdMetadataXml = props.fdMetadataXml.replace("</metadata>",
      '<extendSimpleProperty name="fd_other" label="Other" type="String"/></metadata>');
  });
  assert.deepEqual(draft.form.layout.sourceGrid, source.form.layout, "Retain source geometry as evidence");
  const [row] = draft.form.layout.mkTree;
  assert.equal(row.children.length, 3);
  assert.deepEqual(row.children.map(cell => [cell.column, cell.colspan, cell.widthWeight]),
    [[0, 2, 560], [2, 1, 80], [3, 1, 200]]);
  const originalInputFlow = source.form.layout.rows[0].cells[1].contentFlow;
  assert.deepEqual(row.children[0].contentFlow, originalInputFlow);
  assert.deepEqual(row.children[0].contentFlow.items[0].width, { value: 120, unit: "px" });
  for (const index of [2, 3]) {
    const original = source.form.layout.rows[0].cells[index];
    const retained = row.children[index - 1];
    assert.equal(retained.sourceRef, original.sourceRef);
    assert.deepEqual(retained.contentFlow, original.contentFlow);
    assert.deepEqual(retained.refIds, original.references.map(ref => ref.referenceId));
  }
  assertTrusted(source, draft);
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("keeps folded title ownership and layout references through long field-id remapping", () => {
  const longId = `fd_department_${"source_identity_".repeat(5)}`;
  const { source, draft } = variant(props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replaceAll(subjectId, longId);
    props.fdMetadataXml = props.fdMetadataXml.replaceAll(subjectId, longId);
  });
  assert.equal(draft.form.fields.length, 1);
  const subject = draft.form.fields[0];
  assert.notEqual(subject.id, longId);
  assert.equal(subject.sourceProps.originalId, longId);
  assert.equal(subject.sourceRef, source.form.controls.find(item => item.id === longId).sourceRef);
  assert.equal(subject.title, "申请部门");
  assert.notEqual(subject.props.hiddenLabel, true);
  assert.deepEqual(draft.form.layout.mkTree[0].children[0].refIds, [subject.id]);
  assertTrusted(source, draft);
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

const protectedVariants = [
  ["shared binding", props => {
    const owner = /<DIV fd_type="inputText"[\s\S]*?<\/DIV>/.exec(props.fdDesignerHtml)[0];
    props.fdDesignerHtml = props.fdDesignerHtml.replace(owner, owner + owner.replaceAll(subjectId, "fd_other"));
    props.fdMetadataXml = props.fdMetadataXml.replace("</metadata>",
      '<extendSimpleProperty name="fd_other" label="其他部门" type="String"/></metadata>');
  }],
  ["hidden shared binding", props => {
    const owner = /<DIV fd_type="inputText"[\s\S]*?<\/DIV>/.exec(props.fdDesignerHtml)[0];
    const hidden = owner.replaceAll(subjectId, "fd_other")
      .replace('fd_type="inputText"', 'fd_type="inputText" canShow="false"')
      .replace('label:"申请部门"', 'label:"后台部门",canShow:"false"');
    props.fdDesignerHtml = props.fdDesignerHtml.replace(owner, owner + hidden);
    props.fdMetadataXml = props.fdMetadataXml.replace("</metadata>",
      '<extendSimpleProperty name="fd_other" label="后台部门" type="String"/></metadata>');
  }],
  ["multiple visible editors in the value cell", props => {
    const owner = /<DIV fd_type="inputText"[\s\S]*?<\/DIV>/.exec(props.fdDesignerHtml)[0];
    const other = owner.replaceAll(subjectId, "fd_other")
      .replace('_label_bind:"true",_label_bind_id:"caption_department"', '_label_bind:"false"');
    props.fdDesignerHtml = props.fdDesignerHtml.replace(owner, owner + other);
    props.fdMetadataXml = props.fdMetadataXml.replace("</metadata>",
      '<extendSimpleProperty name="fd_other" label="其他部门" type="String"/></metadata>');
  }],
  ["independent caption permission", props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace("<LABEL ", '<DIV fd_type="right" fd_values=\'{id:"right_caption"}\'><LABEL ')
      .replace("</LABEL>", "</LABEL></DIV>");
  }],
  ["independent editor permission", props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace('<DIV fd_type="inputText"', '<DIV fd_type="right" fd_values=\'{id:"right_editor"}\'><DIV fd_type="inputText"')
      .replace("</DIV>", "</DIV></DIV>");
  }],
  ["caption click handler", props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace("<LABEL ", '<LABEL onclick="showDepartmentHelp()" ');
  }],
  ["caption rich text", props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace(">申请部门</LABEL>", "><strong>申请部门</strong></LABEL>");
  }],
  ...["text-align:right", "text-align:center", "display:block"].map(style => [
    `caption style ${style}`, props => {
      props.fdDesignerHtml = props.fdDesignerHtml.replace("<LABEL ", `<LABEL style="${style}" `);
    }
  ]),
  ["right-aligned caption cell", props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace('<TD class="td_normal_title"', '<TD style="text-align:right" class="td_normal_title"');
  }],
  ["runtime stylesheet hiding the caption", props => {
    props.fdDisplayJsp = runtimeTable + "<style>#caption_department { display:none; }</style>";
  }],
  ["script-referenced caption", props => {
    props.fdDisplayJsp = runtimeTable + '<script>document.getElementById("caption_department").style.display = "none";</script>';
  }],
  ["escaped script caption reference", props => {
    props.fdDisplayJsp = runtimeTable + '<script>hideCaption("caption_\\u0064epartment");</script>';
  }],
  ["concatenated script caption reference", props => {
    props.fdDisplayJsp = runtimeTable + '<script>hideCaption("caption_" + "department");</script>';
  }],
  ["dynamic script caption reference", props => {
    props.fdDisplayJsp = runtimeTable + '<script>var k="caption_";hideCaption(k + "department");</script>';
  }],
  ["computed global DOM reference", props => {
    props.fdDisplayJsp = runtimeTable + '<script>var k="department";globalThis["document"].getElementById("caption_" + k).style.display="none";</script>';
  }],
  ["unregistered designer script", props => {
    props.fdDesignerHtml += '<script>hideAllCaptions();</script>';
  }],
  ["row-spanning caption", props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace('class="td_normal_title"', 'class="td_normal_title" rowspan="2"');
  }],
  ["table header", props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace("<TD class=", "<TH class=").replace("</TD>", "</TH>");
  }],
  ["duplicate caption identity", props => {
    const caption = /<LABEL [\s\S]*?<\/LABEL>/.exec(props.fdDesignerHtml)[0];
    props.fdDesignerHtml = props.fdDesignerHtml.replace(caption, caption + caption);
  }]
];

for (const [name, change] of protectedVariants) it(`retains an independent caption for ${name}`, () => {
  const { draft } = variant(change);
  assertRetained(draft);
});

for (const [name, change] of [
  ["renamed title", dsl => { field(dsl, subjectId).title = "伪造标题"; }],
  ["hidden native title", dsl => { field(dsl, subjectId).props.hiddenLabel = true; }],
  ["lost readonly", dsl => { delete field(dsl, subjectId).props.readOnly; }],
  ["lost required", dsl => { delete field(dsl, subjectId).props.required; }],
  ["changed default", dsl => { field(dsl, subjectId).props.defaultValue = { kind: "literal", value: "财务部" }; }],
  ["forged folded-caption identity", dsl => { field(dsl, subjectId).sourceProps.foldedCaption.id = "invented_caption"; }],
  ["tampered source caption width", dsl => {
    dsl.form.layout.sourceGrid.rows[0].cells[0].contentFlow.items[0].width = { value: 90, unit: "px" };
  }],
  ["resurrected caption", dsl => {
    const original = stages().source.form.controls.find(item => item.id === captionId);
    dsl.form.fields.push({
      id: original.id, title: original.title, type: "description", componentId: "xform-description",
      props: { content: original.title }, sourceProps: original.sourceProps,
      sourceRef: original.sourceRef, generated: false
    });
  }],
  ["lost merged span", dsl => { dsl.form.layout.mkTree[0].children[0].colspan = 1; }]
]) it(`rejects ${name} after a genuine title fold`, () => {
  const { source, draft } = stages();
  assert.equal(field(draft, captionId), undefined, "Test a genuinely folded baseline");
  assertTrusted(source, draft);
  const candidate = trusted(source, draft);
  change(candidate);
  const checked = checkTrust(source, candidate);
  assert.equal(checked.ok, false, "Source-backed title folding must not waive field or layout semantics");
});

it("rejects a target-only claim that an independently permissioned caption was folded", () => {
  const { source, draft } = variant(protectedVariants.find(([name]) => name === "independent caption permission")[1]);
  assertRetained(draft);
  assertTrusted(source, draft);
  const candidate = trusted(source, draft);
  field(candidate, subjectId).sourceProps.foldedCaption = structuredClone(field(stages().draft, subjectId).sourceProps.foldedCaption);
  candidate.form.fields = candidate.form.fields.filter(item => item.id !== captionId);
  delete field(candidate, subjectId).props.hiddenLabel;
  const row = candidate.form.layout.mkTree.find(item => item.children.some(cell => cell.refIds?.includes(captionId)));
  const subjectCell = row.children.find(cell => cell.refIds?.includes(subjectId));
  row.children = [{ ...subjectCell, column: 0, colspan: 2 }];
  assert.equal(checkTrust(source, candidate).ok, false);
});

for (const [name, change] of [
  ["desktop-only hidden native title", config => { config.controlProps.desktop.hiddenLabel = true; }],
  ["mobile-only hidden native title", config => {
    config.labelProps.mobile = { ...config.labelProps.mobile, hiddenLabel: true };
  }],
  ["changed native labelProps title with unchanged fdLabel", config => { config.labelProps.title = "伪造标题"; }],
  ["empty native title", config => { config.labelProps.title = ""; }],
  ["missing native title", config => { delete config.labelProps.title; }],
  ["changed display label", config => { config.labelProps.displayLabel = "Wrong title"; }],
  ["changed mobile display label", config => { config.labelProps.mobile.displayLabel = "Wrong title"; }],
  ["empty desktop title override", config => { config.labelProps.desktop.title = ""; }],
  ["empty mobile title override", config => { config.labelProps.mobile.title = ""; }],
  ["renamed native title", (config, native) => {
    native.fdLabel = "伪造标题";
    config.label = "伪造标题";
    config.controlProps.title = "伪造标题";
    config.labelProps.title = "伪造标题";
  }],
  ["hidden native title", config => {
    for (const scene of ["desktop", "mobile"]) {
      config.controlProps[scene].hiddenLabel = true;
      config.labelProps[scene] = { ...config.labelProps[scene], hiddenLabel: true };
    }
    config.controlProps.showText = false;
    config.labelProps.showText = false;
  }]
]) it(`readback rejects ${name} in the persisted folded field`, () => {
  const { draft } = stages();
  assert.equal(field(draft, captionId), undefined, "Test a genuinely folded baseline");
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
  const corrupt = structuredClone(prepared.update), config = xformConfig(corrupt);
  const native = config.dataModel[0].fdFields.find(item => item.fdName === subjectId);
  const attribute = JSON.parse(native.fdAttribute);
  change(attribute.config, native);
  native.fdAttribute = JSON.stringify(attribute);
  corrupt.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  assert.equal(prepared.verify(corrupt).ok, false);
});
