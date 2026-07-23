import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { formAttr, projectTemplate } from "../helpers/persistence.js";
import { multiRadioRowHelperCandidates, multiRadioRowHelperFormRules } from "../../src/translator/multi-radio-row-helper.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixturePath = "tests/fixtures/source/149c6e78f7c015f4c7da952411fa0cef";
const editShowSourceId = "fd_3df03d37c019fe.script.2";

describe("multi-radio row helper Route case", () => {
  it("projects hideAll/judgeMethod visibility into native formRules.linkage and keeps thin setValue scripts", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const linkage = (dslDraft.formRules?.linkage || []).filter((rule) => (
      rule.translationStatus === "executable" &&
      rule.meta?.basis === "deterministic-multi-radio-row-helper"
    ));
    const mappedHelperActions = dslDraft.scripts.actions.filter((action) => (
      action.functionMappings?.[0]?.basis === "deterministic-multi-radio-row-helper"
    ));

    assert.ok(linkage.length >= 8, `expected multi-radio linkage, got ${linkage.length}`);
    assert.equal(linkage.every((rule) => Array.isArray(rule.when) && rule.when.length >= 1), true);
    assert.equal(linkage.some((rule) => rule.when.some((clause) => clause.op === "in")), true);
    assert.equal(
      linkage.every((rule) => rule.effects.some((effect) => effect.type === "visible")),
      true
    );

    assert.equal(mappedHelperActions.length, 4); // 1 onLoad + 3 onChange
    for (const action of mappedHelperActions) {
      assert.match(action.function, /MKXFORM\.setValue\("fd_qylb_con"/);
      assert.doesNotMatch(action.function, /MKXFORM\.setFieldAttr/);
      assert.doesNotMatch(action.function, /forEach|document|\$\(/);
    }

    const viewOmits = dslDraft.scripts.actions.filter((action) => (
      action.translationStatus === "omitted" &&
      action.sourceRefs?.includes("source.form.jsp.fd_3df03d37c019fe.script.3")
    ));
    assert.ok(viewOmits.length >= 1);

    const diagnostics = checkDraft(dslDraft).diagnostics.filter((item) => item.level === "error");
    assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics, null, 2));

    const formRule = formAttr(projectTemplate(dslDraft)).formRule;
    assert.ok(formRule.display.length > 0, "native display rules must be persisted");
    assert.ok(formRule.require.length > 0, "native require rules must be persisted");
  });

  it("rejects a similarly shaped helper with an external side effect", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const source = structuredClone(
      sourceDraft.scripts.sources.find((entry) => entry.id === editShowSourceId)
    );
    source.javascript = source.javascript.replace(
      "hideAll()",
      "hideAll(); window.alert(\"x\")"
    );
    assert.deepEqual(
      multiRadioRowHelperCandidates(source, dslDraft.form, sourceDraft.scripts),
      []
    );
    assert.equal(multiRadioRowHelperFormRules({
      sources: [source, ...sourceDraft.scripts.sources.filter((entry) => entry.id !== editShowSourceId)]
    }, dslDraft.form), undefined);
  });

  it("rejects when a row marker is absent from layout", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const form = structuredClone(dslDraft.form);
    const strip = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node.sourceMarkers)) {
        node.sourceMarkers = node.sourceMarkers.filter((marker) => marker !== "fd_zdpp_row");
      }
      if (Array.isArray(node)) {
        node.forEach(strip);
        return;
      }
      Object.values(node).forEach(strip);
    };
    strip(form.layout);
    const source = sourceDraft.scripts.sources.find((entry) => entry.id === editShowSourceId);
    assert.deepEqual(multiRadioRowHelperCandidates(source, form, sourceDraft.scripts), []);
    assert.equal(multiRadioRowHelperFormRules(sourceDraft.scripts, form), undefined);
  });
});
