import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runRouteCase } from "./run-route-case.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/dynamic-hyperlink-target/route-hyperlink-target_SysFormTemplate.xml";
const generatedId = "fd_document_Link";

function sourceWith(transform) {
  const source = cleanSourceFile(fixture);
  source.scripts.sources[0].javascript = transform(source.scripts.sources[0].javascript);
  return source;
}

function generated(draft) {
  return draft.form.fields.find(field => field.id === generatedId);
}

describe("explicit new-tab dynamic hyperlink Route-validation", () => {
  it("preserves the source title, target evidence and row behavior through fake readback", async () => {
    const result = await runRouteCase("dynamic-hyperlink-target-success");
    assert.equal(result.dsl.trust.executable, true);
    assert.equal(result.execution.readback.ok, true);
    assert.equal(generated(result.dsl).title, "下载文档");
    assert.equal(generated(result.dsl).sourceProps.dynamicHyperlinkProjection.anchorTarget, "_blank");
    const action = result.dsl.scripts.actions[0];
    assert.equal(action.semanticHints.dynamicHyperlink.anchorTarget, "_blank");
    const values = { fd_document_url: "https://example.invalid/document", fd_category: "A" };
    const attrs = [];
    const invoke = new Function("MKXFORM", `${action.function}; return onLoad;`)({
      getValue: id => values[id], setValue: (id, value) => { values[id] = value; },
      setFieldAttr: (id, value) => attrs.push([id, value])
    });
    invoke();
    assert.deepEqual(JSON.parse(values[generatedId]), [{ linkTitle: "下载文档", url: values.fd_document_url }]);
    assert.deepEqual(attrs, [["fd_document_row", 5], ["fd_document_row", 3], [generatedId, 6], [generatedId, 1]]);
    for (const [url, category] of [["", "A"], ["https://example.invalid/document", "C"], ["javascript:alert(1)", "B"]]) {
      values.fd_document_url = url; values.fd_category = category; attrs.length = 0;
      invoke();
      assert.equal(values[generatedId], "");
      assert.deepEqual(attrs, [["fd_document_row", 4], ["fd_document_row", 6]]);
    }
    values.fd_document_url = "http://example.invalid/again"; values.fd_category = "B"; attrs.length = 0;
    invoke();
    assert.equal(JSON.parse(values[generatedId])[0].linkTitle, "下载文档");
    assert.deepEqual(attrs, [["fd_document_row", 5], ["fd_document_row", 3], [generatedId, 6], [generatedId, 1]]);
  });

  it("persists link display in add/edit and rejects permissions that restore editing", () => {
    const draft = draftSourceDraft(cleanSourceFile(fixture));
    const prepared = prepareSample(draft);
    const config = xformConfig(prepared.update);
    const main = config.dataModel.find(model => model.fdType === "main");
    const field = main.fdFields.find(field => field.fdName === generatedId);
    assert.equal(JSON.parse(field.fdAttribute).config.controlProps.showStatus, "readOnly");
    for (const mode of ["add", "edit"]) {
      assert.equal(config.auth[0][mode][main.fdTableName].fields[generatedId].editable, false);
      const changed = structuredClone(prepared.update);
      const changedConfig = xformConfig(changed);
      changedConfig.auth[0][mode][main.fdTableName].fields[generatedId].editable = true;
      changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(changedConfig);
      const readback = prepared.verify(changed);
      assert.equal(readback.ok, false);
      assert.ok(readback.diagnostics.some(d => d.code === "readback.form.prop_readOnly_mismatch"));
    }
    assert.equal(prepared.verify(prepared.update).ok, true);
  });

  it("accepts a different literal plain-text title and either target quote style", () => {
    const source = sourceWith(text => text.replace("下载文档", "打开资料")
      .replace("target='_blank'", 'target=\\"_blank\\"'));
    const before = JSON.stringify(source);
    const draft = draftSourceDraft(source);
    assert.equal(generated(draft).title, "打开资料");
    assert.equal(checkDraft(draft).ok, true);
    assert.equal(JSON.stringify(source), before);
  });

  it("does not reuse source locals that collide with the target API or compiler temporaries", () => {
    for (const name of ["safeUrl", "MKXFORM", "String", "JSON", "conditionValue", "url"]) {
      for (const variant of ["conditioned-url", "conditioned-kind", "url-only"]) {
        const source = sourceWith(text => variant === "url-only"
          ? `Com_AddEventListener(window, "load", function () {
              var ${name} = GetXFormFieldById("fd_document_url")[0].value;
              if (${name}) { document.getElementById("documentAnchor").innerHTML = "<a target='_blank' href='" + ${name} + "'>下载文档</a>"; }
            });`
          : text.replace(variant === "conditioned-url" ? /\bresource\b/g : /\bcategory\b/g, name));
        const draft = draftSourceDraft(source);
        assert.equal(checkDraft(draft).ok, true, `${variant}:${name}`);
        const values = { fd_document_url: "https://example.invalid/document", fd_category: "A" };
        const invoke = new Function("MKXFORM", `${draft.scripts.actions[0].function}; return onLoad;`)({
          getValue: id => values[id], setValue: (id, value) => { values[id] = value; }, setFieldAttr() {}
        });
        invoke();
        assert.equal(JSON.parse(values[generatedId])[0].url, values.fd_document_url, `${variant}:${name}`);
      }
    }
  });

  it("rejects unknown targets, additional attributes, markup, entity ambiguity and reset effects", () => {
    const transforms = [
      text => text.replace("_blank", "_self"),
      text => text.replace("_blank", "namedWindow"),
      text => text.replace("target='_blank'", "target='_blank' onclick='danger()'"),
      text => text.replace("下载文档", "<b>下载文档</b>"),
      text => text.replace("下载文档", "下载&amp;文档"),
      text => text.replace("下载文档", ""),
      text => text.replace('true, true, false', 'true, true, true'),
      text => text.replace('var resource =', 'audit(); var resource ='),
      text => text.replace('category == \'A\' || category == \'B\'', 'category == \'A\' && category == \'B\'')
    ];
    for (const transform of transforms) {
      const draft = draftSourceDraft(sourceWith(transform));
      assert.equal(generated(draft), undefined);
      assert.equal(draft.scripts.actions.some(a => a.translationStatus === "needs_review"), true);
    }
  });

  it("keeps generated-field collision and deterministic proof checks", () => {
    const source = cleanSourceFile(fixture);
    source.form.controls.push({ ...source.form.controls[0], id: generatedId, sourceRef: "source.form.control.fd_existing" });
    assert.equal(draftSourceDraft(source).form.fields.some(f => f.generated), false);
    const draft = draftSourceDraft(cleanSourceFile(fixture));
    draft.scripts.actions[0].function = draft.scripts.actions[0].function.replace("下载文档", "changed");
    assert.ok(checkDraft(draft).diagnostics.some(d => d.code === "dsl.scripts.deterministic_branch_proof_invalid"));
  });
});
