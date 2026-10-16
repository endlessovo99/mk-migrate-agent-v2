import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/sql-selector-readonly/sql-readonly_SysFormTemplate.xml";
const stages = () => { const source = cleanSourceFile(fixture); return { source, dsl: draftSourceDraft(source) }; };
const companion = dsl => dsl.form.fields.find(field => field.id === "fd_lines").columns.find(field => field.id === "project_name");
const assertRemoteUnbound = (source, dsl) => {
  const checked = checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true }));
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some(item => item.code === "trust.form.remote_dialog_unbound"));
  assert.ok(!checked.diagnostics.some(item => item.code === "trust.form.read_only_source_mismatch"));
};
const rootProperties = parseRootHashMapStringPuts(readFileSync(fixture, "utf8"));
const runtimeTag = rootProperties.fdDisplayJsp.match(/<xform:text property="extendDataFormInfo.value\(fd_lines\.\!\{index\}\.project_name\)"[^>]*\/>/)[0];

function variant(change) {
  const properties = { ...rootProperties };
  change(properties);
  const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const directory = mkdtempSync(join(tmpdir(), "sql-readonly-"));
  const file = join(directory, "variant_SysFormTemplate.xml");
  try {
    writeFileSync(file, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(properties).map(([key, value]) => `<void method="put"><string>${key}</string><string>${escape(value)}</string></void>`).join("") +
      "</object></java>");
    const source = cleanSourceFile(file);
    return { source, dsl: draftSourceDraft(source) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const runtimeVariant = replacement => variant(properties => {
  properties.fdDisplayJsp = properties.fdDisplayJsp.replace(runtimeTag, replacement);
});

describe("SQL selector text restrictions", () => {
  it("preserves typed SQLDialog text restrictions on existing main and detail scalar projections", () => {
    const { source, dsl } = stages();
    const main = dsl.form.fields.find(field => field.id === "fd_project");
    const detail = dsl.form.fields.find(field => field.id === "fd_lines");
    assert.equal(source.form.controls.find(field => field.id === "fd_project").sourceProps.designerValues.txtReadOnly, "true");
    assert.equal(main.props.readOnly, true);
    assert.equal(detail.columns.find(field => field.id === "project").props.readOnly, true);
    assert.notEqual(dsl.form.fields.find(field => field.id === "fd_editable").props.readOnly, true);
    assert.ok(dsl.review.warnings.some(warning => warning.code === "source.sysform.sql_dialog_partial"));
  });

  it("retains explicit runtime readonly for an existing metadata text in the same detail scope", () => {
    const { source, dsl } = stages();
    const column = source.form.detailTables[0].columns.find(field => field.id === "project_name");
    assert.equal(column.sourceProps.designerValues, undefined);
    assert.equal(column.sourceProps.runtimeTextReadOnly?.readOnly, true);
    assert.equal(dsl.form.fields.find(field => field.id === "fd_lines").columns.find(field => field.id === "project_name").props.readOnly, true);
  });

  for (const [name, replacement] of [
    ["HTML comment", `<!-- ${runtimeTag} -->`],
    ["JSP comment", `<%-- ${runtimeTag} --%>`],
    ["JSP code string", `<% String markup = '${runtimeTag}'; %>`],
    ["script string", `<script>var markup = '${runtimeTag}';</script>`],
    ["style text", `<style>${runtimeTag}</style>`],
    ["textarea text", `<textarea>${runtimeTag}</textarea>`],
    ["code sample", `<code>${runtimeTag}</code>`],
    ["non-empty JSP text body", `<xform:text property="other">'${runtimeTag}'</xform:text>`],
    ["unproven non-self-closing text", runtimeTag.replace("/>", "></xform:text>")],
    ["quoted attribute", `<div title="${runtimeTag.replaceAll('"', "&quot;")}"></div>`],
    ["encoded text", runtimeTag.replaceAll("<", "&lt;").replaceAll(">", "&gt;")],
    ["other table", runtimeTag.replace("fd_lines.", "fd_other.")],
    ["main scope with the same column id", runtimeTag.replace("fd_lines.!{index}.project_name", "project_name")],
    ["unknown row binding", runtimeTag.replace("!{index}", "${other.index}")],
    ["name suffix without readonly", runtimeTag.replace(` htmlElementProperties="readOnly='readOnly'"`, "")],
    ["readonly word in another value", runtimeTag.replace("readOnly='readOnly'", "title='readOnly'")],
    ["data-readonly attribute", runtimeTag.replace("readOnly='readOnly'", "data-readonly='readOnly'")],
    ["conflicting rendered variant", runtimeTag + runtimeTag.replace(` htmlElementProperties="readOnly='readOnly'"`, "")],
    ["duplicate property", runtimeTag.replace(" htmlElementProperties", ' property="extendDataFormInfo.value(fd_other)" htmlElementProperties')],
    ["missing attribute separator", runtimeTag.replace('" htmlElementProperties', '"htmlElementProperties')],
    ["dynamic runtime attributes", runtimeTag.replace("readOnly='readOnly'", "${attrs}")]
  ]) {
    it(`does not infer a runtime text restriction from ${name}`, () => {
      const { source, dsl } = runtimeVariant(replacement);
      assert.equal(source.form.detailTables[0].columns.find(field => field.id === "project_name").sourceProps.runtimeTextReadOnly, undefined);
      assert.notEqual(companion(dsl).props.readOnly, true);
    });
  }

  for (const htmlBoolean of ["readonly", "READONLY", "readonly='false'", "readonly='0'"]) {
    it(`uses HTML presence semantics for ${htmlBoolean}`, () => {
      assert.equal(companion(runtimeVariant(runtimeTag.replace("readOnly='readOnly'", htmlBoolean)).dsl).props.readOnly, true);
    });
  }

  it("accepts consistent template and existing-row bindings without relying on a name suffix", () => {
    const { source, dsl } = variant(properties => {
      properties.fdMetadataXml = properties.fdMetadataXml.replace('name="project_name"', 'name="caption"');
      const renamed = runtimeTag.replace(".project_name", ".caption");
      properties.fdDisplayJsp = properties.fdDisplayJsp.replace(runtimeTag, renamed + renamed.replace("!{index}", "${vstatus.index}"));
    });
    const field = dsl.form.fields.find(field => field.id === "fd_lines").columns.find(field => field.id === "caption");
    assert.equal(field.props.readOnly, true);
    assert.equal(source.form.detailTables[0].columns.find(field => field.id === "caption").sourceProps.runtimeTextReadOnly.evidence.length, 2);
  });

  it("keeps Designer false/absent values and unrelated control families distinct from HTML boolean attributes", () => {
    for (const replacement of ['txtReadOnly:"false"', "", 'txtReadOnly:"1"']) {
      const { dsl } = variant(properties => { properties.fdDesignerHtml = properties.fdDesignerHtml.replaceAll('txtReadOnly:"true"', replacement); });
      assert.notEqual(dsl.form.fields.find(field => field.id === "fd_project").props.readOnly, true);
      assert.notEqual(dsl.form.fields.find(field => field.id === "fd_lines").columns.find(field => field.id === "project").props.readOnly, true);
    }
    const { dsl } = variant(properties => { properties.fdDesignerHtml = properties.fdDesignerHtml.replaceAll('fd_type="SQLDialog"', 'fd_type="inputText"'); });
    assert.notEqual(dsl.form.fields.find(field => field.id === "fd_project").props.readOnly, true);
    assert.notEqual(companion(dsl).props.readOnly, true);
  });

  for (const literal of ['["true"]', "[true]", '{toString:"true"}', "1", "0", "null"]) {
    it(`does not infer readonly from unsupported XML Designer literal ${literal}`, () => {
      const { source, dsl } = variant(properties => {
        properties.fdDesignerHtml = properties.fdDesignerHtml.replaceAll('txtReadOnly:"true"', `txtReadOnly:${literal}`);
      });
      assert.notEqual(dsl.form.fields.find(field => field.id === "fd_project").props.readOnly, true);
      assert.notEqual(dsl.form.fields.find(field => field.id === "fd_lines").columns.find(field => field.id === "project").props.readOnly, true);
      assertRemoteUnbound(source, dsl);
    });
  }

  // XML string attributes and public Source Draft JSON values are different input seams.
  // The latter must not coerce arrays/objects into the new SQL permission fact.
  for (const value of [["true"], [true], { toString: "true" }, {}, 1, 0, null, false, "false"]) {
    it(`rejects coercion of SQL txtReadOnly JSON value ${JSON.stringify(value)}`, () => {
      const { source } = stages();
      source.form.controls.find(field => field.id === "fd_project").sourceProps.designerValues.txtReadOnly = value;
      source.form.detailTables[0].columns.find(field => field.id === "project").sourceProps.designerValues.txtReadOnly = value;
      const dsl = draftSourceDraft(source);
      assert.notEqual(dsl.form.fields.find(field => field.id === "fd_project").props.readOnly, true);
      assert.notEqual(dsl.form.fields.find(field => field.id === "fd_lines").columns.find(field => field.id === "project").props.readOnly, true);
      assertRemoteUnbound(source, dsl);
    });
  }

  for (const value of [true, "true", " TRUE "]) {
    it(`preserves literal SQL txtReadOnly ${JSON.stringify(value)} through projection and trust`, () => {
      const { source } = stages();
      source.form.controls.find(field => field.id === "fd_project").sourceProps.designerValues.txtReadOnly = value;
      const dsl = draftSourceDraft(source);
      const field = dsl.form.fields.find(field => field.id === "fd_project");
      assert.equal(field.props.readOnly, true);
      delete field.props.readOnly;
      const checked = checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true }));
      assert.equal(checked.ok, false);
      assert.ok(checked.diagnostics.some(item => item.code === "trust.form.read_only_source_mismatch"));
    });
  }

  it("preserves source SQL/output metadata and existing field/layout identities", () => {
    const { source, dsl } = stages();
    const main = source.form.controls.find(field => field.id === "fd_project");
    assert.equal(main.sourceProps.designerValues.sqlResource, "synthetic-source-resource");
    assert.equal(main.sourceProps.designerValues.sqlvalue, "select code, title, departmentCode, department from synthetic_projects");
    assert.equal(main.sourceProps.designerValues.readOnly, undefined);
    assert.deepEqual(dsl.form.fields.map(field => field.id), ["fd_project", "fd_editable", "fd_lines"]);
    assert.deepEqual(dsl.form.fields.find(field => field.id === "fd_lines").columns.map(field => field.id), ["project", "departmentCode", "department", "project_name"]);
    assert.equal(source.form.detailTables[0].columns.find(field => field.id === "project").sourceProps.designerValues._outputParams,
      "{'outputParams':[{'name':'DEPARTMENTCODE','isUse':'true','idField':'$fd_lines.departmentCode$','nameField':'$Lines.Department code$'},{'name':'DEPARTMENT','isUse':'true','idField':'$fd_lines.department$','nameField':'$Lines.Department$'}]}");
  });

  it("rejects readonly weakening at patch and external-trust boundaries even when target hints are deleted", () => {
    const { source, dsl } = stages();
    const paths = ["/form/fields/0", "/form/fields/2/columns/0", "/form/fields/2/columns/3"];
    for (const path of paths) {
      const parts = path.slice(1).split("/");
      const target = parts.reduce((value, key) => value[key], dsl);
      for (const [suffix, value] of [["props", { readOnly: false }], ["sourceProps", {}]]) {
        const result = applyEvidenceBackedPatches(dsl, [{ op: "replace", path: `${path}/${suffix}`, value,
          sourceRefs: [target.sourceRef], evidence: ["Attempt to weaken the source permission"], confidence: 1, rationale: "Editable candidate" }],
        { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
        assert.equal(result.ok, false);
      }
      for (const kind of ["delete", "false", "delete-hints"]) {
        const candidate = structuredClone(dsl);
        const changed = parts.reduce((value, key) => value[key], candidate);
        if (kind === "false") changed.props.readOnly = false;
        else delete changed.props.readOnly;
        if (kind === "delete-hints") delete changed.sourceProps;
        const result = checkTrust(source, createTrustedMigrationDsl(source, candidate, { externalAgentReviewed: true }));
        assert.equal(result.ok, false);
        assert.ok(result.diagnostics.some(item => item.code === "trust.form.read_only_source_mismatch"));
      }
    }
    assertRemoteUnbound(source, dsl);
  });

  it("persists all three text restrictions and rejects each native attribute/add/edit permission loss", () => {
    const { dsl } = stages();
    const prepared = prepareSample(dsl);
    const config = xformConfig(prepared.update);
    const main = config.dataModel.find(model => model.fdType === "main");
    const detail = config.dataModel.find(model => model.fdType === "detail");
    assert.equal(prepared.verify(prepared.update).ok, true);
    for (const [table, id] of [[main.fdTableName, "fd_project"], [detail.fdTableName, "project"], [detail.fdTableName, "project_name"]]) {
      const model = config.dataModel.find(model => model.fdTableName === table);
      assert.equal(JSON.parse(model.fdFields.find(field => field.fdName === id).fdAttribute).config.controlProps.showStatus, "readOnly");
      for (const mode of ["add", "edit"]) assert.equal(config.auth[0][mode][table].fields[id].editable, false);
      for (const loss of ["showStatus", "add", "edit"]) {
        const mutated = structuredClone(prepared.update), changed = xformConfig(mutated);
        if (loss === "showStatus") {
          const field = changed.dataModel.find(model => model.fdTableName === table).fdFields.find(field => field.fdName === id);
          const attrs = JSON.parse(field.fdAttribute); delete attrs.config.controlProps.showStatus; field.fdAttribute = JSON.stringify(attrs);
        } else changed.auth[0][loss][table].fields[id].editable = true;
        mutated.mechanisms["sys-xform"].fdConfig = JSON.stringify(changed);
        const result = prepared.verify(mutated);
        assert.equal(result.ok, false);
        assert.ok(result.diagnostics.some(item => item.code === "readback.form.prop_readOnly_mismatch"));
      }
    }
  });

  it("blocks unbound SQL during review while retaining restrictions and source warnings", async () => {
    const result = await runRouteCase("sql-selector-readonly-projection-without-write");
    assert.ok(result.dsl.review.warnings.some(item => item.code === "source.sysform.sql_dialog_partial"));
    assert.equal(companion(result.dsl).props.readOnly, true);
    assert.equal(result.review.status, "blocked");
    assert.equal(result.execution, undefined);
    assert.deepEqual(result.transcript, []);
  });
});
