import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runRouteCase } from "./run-route-case.js";
import { localCorpusIt } from "../helpers/local-corpus.js";

const fixture = "tests/fixtures/route-validation/permission-caption-row/route-permission-caption-row_SysFormTemplate.xml";

describe("source-visible title beside a permission-wrapped editor", () => {
  it("retains the local caption and source span without using the stale binding as its visible title", () => {
    const draft = draftSourceDraft(cleanSourceFile(fixture));
    const fields = new Map(draft.form.fields.map(field => [field.id, field]));
    for (const [id, caption, title, right] of [
      ["fd_manager", "label_manager", "INTERNAL_manager", "right_manager"],
      ["fd_notes", "label_notes", "INTERNAL_notes", "right_notes"]
    ]) {
      assert.equal(fields.get(caption)?.componentId, "xform-description");
      assert.equal(fields.get(id).title, title);
      assert.equal(fields.get(id).props.hiddenLabel, true);
      assert.equal(fields.get(id).props.required, true);
      assert.equal(fields.get(id).sourceProps.rightContainer.id, right);
      assert.equal(fields.get(id).sourceProps.designerValues._label_bind_id, "label_elsewhere");
      const row = draft.form.layout.mkTree.find(row => row.children.some(cell => cell.refIds.includes(id)));
      assert.equal(row.props.columns, 6);
      assert.deepEqual(row.children.map(cell => cell.colspan), [1, 5]);
      assert.deepEqual(row.children[0].refIds, [caption]);
    }
    assert.deepEqual(fields.get("fd_manager").props.defaultValue, { kind: "literal", value: "Default reviewer" });
  });

  it("does not infer title hiding through a conditional or explicit showLabel renderer", t => {
    const root = mkdtempSync(join(tmpdir(), "permission-caption-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const xml = readFileSync(fixture, "utf8");
    for (const [name, text] of [
      ["conditional", xml.replaceAll("&lt;xform:right mode_N2=", "&lt;c:if test=\"${allowed}\"&gt;&lt;xform:right mode_N2=").replaceAll("&lt;/xform:right&gt;", "&lt;/xform:right&gt;&lt;/c:if&gt;")],
      ["show-label", xml.replaceAll("&lt;xform:xtext ", "&lt;xform:xtext showLabel=\"true\" ")],
      ["different-row", xml.replace("<string>&lt;table&gt;&lt;tbody&gt;&lt;tr&gt;&lt;td&gt;Quality manager:", "<string>&lt;table&gt;&lt;tbody&gt;&lt;tr&gt;&lt;td&gt;Unrelated source caption:")]
    ]) {
      const path = join(root, `${name}_SysFormTemplate.xml`);
      writeFileSync(path, text);
      const draft = draftSourceDraft(cleanSourceFile(path));
      assert.notEqual(draft.form.fields.find(field => field.id === "fd_manager").props.hiddenLabel, true, name);
    }
  });

  it("uses a retained external permission caption for text and radio editors", t => {
    const root = mkdtempSync(join(tmpdir(), "external-permission-caption-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const xml = readFileSync(fixture, "utf8")
      .replace('_label_bind_id:"label_elsewhere"', '_label_bind_id:"label_manager"');
    for (const radio of [false, true]) {
      const text = radio ? xml.replace('fd_type="inputText"', 'fd_type="inputRadio"')
        .replace('width:"120",required:', 'items:"Yes|yes",width:"120",required:')
        .replace('&lt;xform:xtext ', '&lt;xform:radio ') : xml;
      const path = join(root, `${radio ? "radio" : "text"}_SysFormTemplate.xml`);
      writeFileSync(path, text);
      const draft = draftSourceDraft(cleanSourceFile(path));
      const field = draft.form.fields.find(field => field.id === "fd_manager");
      assert.equal(field.props.hiddenLabel, true);
      assert.equal(field.sourceProps.rightContainer.id, "right_manager");
      assert.equal(draft.form.fields.find(field => field.id === "label_manager")?.props.content, "Quality manager:");
    }
  });

  it("verifies the caption and hidden editor title in the persisted fake template", async () => {
    const result = await runRouteCase("permission-caption-row-success");
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.readback.form.fields.find(field => field.id === "fd_manager").hiddenLabel, true);
    assert.equal(result.execution.readback.form.fields.find(field => field.id === "label_manager").content, "Quality manager:");
  });

  localCorpusIt("retains all seven actual quality-manager captions and hides their internal subjects", () => {
    const draft = draftSourceDraft(cleanSourceFile("tests/fixtures/source/18b940a16be81952fdd4eb64816aa02c"));
    const fields = new Map(draft.form.fields.map(field => [field.id, field]));
    for (const [caption, id] of [
      ["fd_3ce7effae043be", "fd_3ce80d2bcec1d0"], ["fd_3ce7f0155ac384", "fd_3ce80d4486978c"],
      ["fd_3ce7f025fe5290", "fd_3ce80d4fdb7b68"], ["fd_3ce7f07fe5d31a", "fd_3ce80d59fc1c0a"],
      ["fd_3ce7f0960df064", "fd_3ce80d6250730c"], ["fd_3ce7f0a3930d5a", "fd_3ce80d6b4f2b66"],
      ["fd_3cbbe916b218aa", "fd_3ce80d7190bd66"]
    ]) {
      assert.equal(fields.get(caption)?.props.content, "质量经理：", caption);
      assert.equal(fields.get(id)?.props.hiddenLabel, true, id);
    }
    for (const id of ["fd_3cb9c9653a3042", "fd_seal_type1"]) {
      assert.equal(fields.get(id)?.props.hiddenLabel, true, id);
    }
  });
});
