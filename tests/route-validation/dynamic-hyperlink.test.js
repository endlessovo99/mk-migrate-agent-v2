import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixturePath = "tests/fixtures/source/18aac2e235a65c382f6fe264e1dba521";
const sourceRef = "source.form.jsp.fd_3bd8452009532c.script.1";
const actionId = "fd_3bd8452009532c.script.1.event.1";

describe("dynamic invoice hyperlink Route case", () => {
  it("projects the exact legacy anchor into a native hyperlink field and proof-bound onLoad", () => {
    const dslDraft = draftSourceDraft(cleanSourceFile(fixturePath));
    const sourceUrl = dslDraft.form.fields.find((field) => field.id === "invoiceUrl");
    const hyperlink = dslDraft.form.fields.find((field) => field.id === "invoiceLink");
    const row = dslDraft.form.layout.mkTree.find((candidate) => (
      candidate.sourceMarkers?.includes("receipt_row1")
    ));
    const action = dslDraft.scripts.actions.find((candidate) => candidate.id === actionId);

    assert.equal(sourceUrl.dataOnly, true);
    assert.equal(sourceUrl.componentId, "xform-input");
    assert.deepEqual(hyperlink.props, { largestSet: 1, editable: false });
    assert.equal(hyperlink.type, "hyperlinks");
    assert.equal(hyperlink.componentId, "xform-hyperlinks");
    assert.equal(hyperlink.generated, true);
    assert.equal(hyperlink.sourceProps.dynamicHyperlinkProjection.urlPolicy, "http-or-https");
    assert.equal(row.componentId, "xform-flex-1-2-layout");
    assert.equal(row.props.columns, 2);
    assert.equal(row.children.some((child) => child.refIds?.includes("invoiceLink")), true);

    assert.equal(action.translationStatus, "mapped");
    assert.equal(action.functionMappings[0].basis, "deterministic-dynamic-hyperlink");
    assert.equal(action.deterministicBranchProof.basis, "deterministic-dynamic-hyperlink");
    assert.match(action.function, /JSON\.stringify\(\[\{ linkTitle: "查看发票", url: url \}\]\)/u);
    assert.match(action.function, /url\.indexOf\("https:\/\/"\) === 0/u);
    assert.match(action.function, /MKXFORM\.setValue\("invoiceLink"/u);
    assert.match(action.function, /MKXFORM\.setFieldAttr\("receipt_row1", 3\)/u);
    assert.doesNotMatch(action.function, /document|innerHTML/u);
    assert.doesNotThrow(() => Function("MKXFORM", `${action.function}; return onLoad;`));
    assert.equal(
      checkDraft(dslDraft).diagnostics.some((diagnostic) => diagnostic.level === "error"),
      false
    );

    const changed = structuredClone(dslDraft);
    const changedAction = changed.scripts.actions.find((candidate) => candidate.id === action.id);
    changedAction.function = changedAction.function.replace("查看发票", "发票详情");
    assert.equal(
      checkDraft(changed).diagnostics.some((diagnostic) => (
        diagnostic.code === "dsl.scripts.deterministic_branch_proof_invalid"
      )),
      true
    );
  });

  it("does not project a similarly shaped source that adds an external side effect", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const source = sourceDraft.scripts.sources.find((candidate) => candidate.sourceRef === sourceRef);
    source.javascript = source.javascript.replace(
      "var url = GetXFormFieldById(\"invoiceUrl\")[0].value;",
      "var url = GetXFormFieldById(\"invoiceUrl\")[0].value; audit(url);"
    );
    const dslDraft = draftSourceDraft(sourceDraft);
    const action = dslDraft.scripts.actions.find((candidate) => candidate.id === actionId);

    assert.equal(dslDraft.form.fields.some((field) => field.id === "invoiceLink"), false);
    assert.equal(action.translationStatus, "needs_review");
  });
});
