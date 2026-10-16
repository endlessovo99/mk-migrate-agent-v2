import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/sql-dialog-hidden-primary/sql-hidden-primary_SysFormTemplate.xml";
const rootProperties = parseRootHashMapStringPuts(readFileSync(fixture, "utf8"));
const primaryRefs = ["source.form.control.fd_lookup", "source.form.detailTable.fd_lines.column.project"];
const displayRefs = ["source.form.control.fd_lookup_name", "source.form.detailTable.fd_lines.column.project_name"];

function stages(change) {
  const properties = { ...rootProperties };
  change?.(properties);
  const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const directory = mkdtempSync(join(tmpdir(), "sql-hidden-primary-"));
  const file = join(directory, "source_SysFormTemplate.xml");
  try {
    writeFileSync(file, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(properties).map(([key, value]) => `<void method="put"><string>${key}</string><string>${escape(value)}</string></void>`).join("") +
      "</object></java>");
    const source = cleanSourceFile(file);
    assert.ok(!source.issues.some(issue => issue.code === "source.sysform.designer_layout_missing"));
    return { source, dsl: draftSourceDraft(source) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function sourceField(source, ref) {
  const fields = [...source.form.controls, ...source.form.dataFields, ...source.form.detailTables.flatMap(table => table.columns)];
  const field = fields.find(candidate => candidate.sourceRef === ref);
  assert.ok(field, ref);
  return field;
}

function targetField(dsl, ref) {
  const field = dsl.form.fields.flatMap(candidate => candidate.type === "detailTable" ? candidate.columns : [candidate])
    .find(candidate => candidate.sourceRef === ref);
  assert.ok(field, ref);
  return field;
}

function nativeField(template, id) {
  const field = xformConfig(template).dataModel.flatMap(model => model.fdFields).find(candidate => candidate.fdName === id);
  assert.ok(field, id);
  return { field, attribute: JSON.parse(field.fdAttribute) };
}

for (const [label, ref] of [["main", primaryRefs[0]], ["detail", primaryRefs[1]]]) {
  test(`keeps the ${label} SQL primary hidden from exact runtime noShow declarations`, () => {
    const { source, dsl } = stages();
    const original = sourceField(source, ref), mapped = targetField(dsl, ref);
    assert.equal(original.sourceProps.designerType, "SQLDialog");
    assert.equal(original.sourceProps.hardHidden, true);
    assert.equal(original.sourceProps.designerValues.showStatus, undefined);
    assert.equal(original.sourceProps.designerValues.sqlResource, "fixture-source-resource");
    assert.equal(original.dataOnly, undefined);
    assert.equal(mapped.componentId, "xform-hidden");
    assert.equal(mapped.dataOnly, undefined);
    assert.equal(mapped.props.required, true);
    assert.equal(mapped.props.readOnly, true);
    const prepared = prepareSample({ form: dsl.form });
    const persisted = nativeField(prepared.update, mapped.id);
    assert.equal(persisted.field.fdIsStored, true);
    assert.equal(persisted.attribute.config.controlProps.hidden, true);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });
}

test("retains the existing display identities, readonly restrictions and required values", () => {
  const { source, dsl } = stages();
  const prepared = prepareSample({ form: dsl.form });
  for (const ref of displayRefs) {
    const original = sourceField(source, ref), mapped = targetField(dsl, ref);
    assert.notEqual(original.sourceProps.hardHidden, true);
    assert.equal(mapped.componentId, "xform-input");
    assert.equal(mapped.props.readOnly, true);
    assert.equal(mapped.props.required, true);
    assert.equal(nativeField(prepared.update, mapped.id).attribute.config.controlProps.showStatus, "readOnly");
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});

test("keeps visible SQL fields, unrelated names and quoted hidden-tag text visible", () => {
  const { dsl } = stages(properties => {
    properties.fdDisplayJsp = properties.fdDisplayJsp.replaceAll('showStatus="noShow"', 'showStatus="edit"');
  });
  for (const ref of [...primaryRefs, "source.form.control.fd_plain_name", "source.form.control.fd_literal",
    "source.form.detailTable.fd_other_lines.column.otherProject"]) {
    assert.equal(targetField(dsl, ref).componentId, "xform-input");
  }
});

test("applies the same source fact after field/table renaming and repeated row templates", () => {
  const { source, dsl } = stages(properties => {
    for (const key of ["fdDesignerHtml", "fdMetadataXml", "fdDisplayJsp"]) {
      properties[key] = properties[key].replaceAll("fd_lookup", "fd_choice").replaceAll("fd_lines", "fd_records")
        .replaceAll("project", "selection");
    }
    properties.fdDisplayJsp += '<xform:text property="extendDataFormInfo.value(fd_records.!{index}.selection)" showStatus="noShow"/>';
  });
  for (const ref of ["source.form.control.fd_choice", "source.form.detailTable.fd_records.column.selection"]) {
    assert.equal(sourceField(source, ref).sourceProps.hardHidden, true);
    assert.equal(targetField(dsl, ref).componentId, "xform-hidden");
  }
  const prepared = prepareSample({ form: dsl.form });
  assert.equal(prepared.verify(prepared.update).ok, true);
});

for (const [label, change] of [
  ["dynamic showStatus", properties => { properties.fdDisplayJsp = properties.fdDisplayJsp.replaceAll('showStatus="noShow"', 'showStatus="${visibility}"'); }],
  ["conflicting view declarations", properties => {
    properties.fdDisplayJsp = properties.fdDisplayJsp
      .replace('value(fd_lookup)" showStatus="noShow"', 'value(fd_lookup)" showStatus="edit"')
      .replace('value(fd_lines.!{index}.project)" showStatus="noShow"', 'value(fd_lines.!{index}.project)" showStatus="edit"');
  }],
  ["different properties", properties => {
    properties.fdDisplayJsp = properties.fdDisplayJsp.replaceAll("value(fd_lookup)", "value(fd_other)")
      .replaceAll("value(fd_lines.", "value(fd_unrelated.");
  }],
  ["unknown detail-row expressions", properties => {
    properties.fdDisplayJsp = properties.fdDisplayJsp.replaceAll("!{index}", "${otherRow}").replaceAll("${vstatus.index}", "${otherRow}")
      .replaceAll('value(fd_lookup)" showStatus="noShow"', 'value(fd_lookup)" showStatus="${visibility}"');
  }],
  ["unproved JSTL conditions", properties => { properties.fdDisplayJsp = `<c:if test="\u0024{condition}">${properties.fdDisplayJsp}</c:if>`; }],
  ["unproved JSP conditions", properties => { properties.fdDisplayJsp = `<% if (condition) { %>${properties.fdDisplayJsp}<% } %>`; }],
  ["quoted and commented markup", properties => {
    properties.fdDisplayJsp = `<script>var markup = ${JSON.stringify(properties.fdDisplayJsp)};</script><!-- ${properties.fdDisplayJsp} -->`;
  }],
  ["ordinary source controls", properties => { properties.fdDesignerHtml = properties.fdDesignerHtml.replaceAll('fd_type="SQLDialog"', 'fd_type="inputText"'); }]
]) {
  test(`does not infer hard hiding from ${label}`, () => {
    const { source, dsl } = stages(change);
    for (const ref of primaryRefs) {
      assert.notEqual(sourceField(source, ref).sourceProps.hardHidden, true);
      assert.equal(targetField(dsl, ref).componentId, "xform-input");
    }
  });
}

test("distinguishes the same leaf field in another table without using its suffix as evidence", () => {
  const { source, dsl } = stages(properties => {
    for (const key of ["fdDesignerHtml", "fdMetadataXml", "fdDisplayJsp"]) properties[key] = properties[key].replaceAll("otherProject", "project");
  });
  assert.equal(sourceField(source, "source.form.detailTable.fd_lines.column.project").sourceProps.hardHidden, true);
  assert.notEqual(sourceField(source, "source.form.detailTable.fd_other_lines.column.project").sourceProps.hardHidden, true);
  assert.equal(targetField(dsl, "source.form.detailTable.fd_other_lines.column.project").componentId, "xform-input");
});

test("ignores a completed unrelated condition before the hidden field", () => {
  const { dsl } = stages(properties => { properties.fdDisplayJsp = `<c:if test="\u0024{condition}">Other content</c:if>${properties.fdDisplayJsp}`; });
  for (const ref of primaryRefs) assert.equal(targetField(dsl, ref).componentId, "xform-hidden");
});

for (const [label, change] of [
  ["static JSP include", html => '<%@ include file="unavailable-fragment.jsp" %>' + html],
  ["runtime JSP include", html => '<jsp:include page="unavailable-fragment.jsp"/>' + html],
  ["unknown custom scope", html => '<custom:if test="${condition}">' + html + "</custom:if>"]
]) {
  test(`does not promote local noShow to global hard hiding with an ${label}`, () => {
    const { source, dsl } = stages(properties => { properties.fdDisplayJsp = change(properties.fdDisplayJsp); });
    for (const ref of primaryRefs) {
      assert.notEqual(sourceField(source, ref).sourceProps.hardHidden, true);
      assert.equal(targetField(dsl, ref).componentId, "xform-input");
    }
  });
}

test("allows a static taglib declaration without allowing unknown rendered tags", () => {
  const { dsl } = stages(properties => {
    properties.fdDisplayJsp = '<%@ taglib uri="/WEB-INF/tld/xform.tld" prefix="xform" %>' + properties.fdDisplayJsp;
  });
  for (const ref of primaryRefs) assert.equal(targetField(dsl, ref).componentId, "xform-hidden");
});

test("independent native readback rejects turning a source-hidden primary back into an input", () => {
  const { dsl } = stages(), prepared = prepareSample({ form: dsl.form });
  for (const ref of primaryRefs) {
    const changed = structuredClone(prepared.update), config = xformConfig(changed);
    const field = config.dataModel.flatMap(model => model.fdFields).find(candidate => candidate.fdName === targetField(dsl, ref).id);
    const attribute = JSON.parse(field.fdAttribute);
    attribute.config.controlProps.desktop.type = "@elem/xform-input";
    attribute.config.controlProps.mobile.type = "@elem/xform-m-input";
    attribute.config.controlProps.hidden = false;
    field.fdAttribute = JSON.stringify(attribute);
    changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    const result = prepared.verify(changed);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => ["readback.form.component_mismatch", "readback.form.detail_column_component"].includes(item.code)));
  }
});

test("retains SQL lookup execution blockers after restoring the hidden source primary", () => {
  const { source, dsl } = stages();
  const trusted = createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true, reviewerName: "hidden-source-fact-only" });
  for (const result of [checkTrust(source, trusted), checkExecute(trusted), buildDryRunPlan(trusted)]) {
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.code.endsWith(".remote_dialog_unbound")));
  }
});
