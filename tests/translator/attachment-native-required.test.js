import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { isUnconditionalAttachmentRequirement } from "../../src/translator/attachment-non-empty.js";
import {
  applyStaticScriptProperties,
  draftMkScriptsFromSourceScripts
} from "../../src/translator/sysform-jsp-scripts.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fieldId = "fd_attach";

describe("attachment native-required closure", () => {
  it("accepts only the two complete observed active-file guard shapes", () => {
    assert.equal(isUnconditionalAttachmentRequirement(directGuard(), fieldId), true);
    assert.equal(isUnconditionalAttachmentRequirement(filteredGuard(), fieldId), true);
  });

  it("rejects conditional, side-effecting, and non-plain guard variants", () => {
    const cases = [
      filteredGuard({ after: "sendAuditEvent();" }),
      filteredGuard({ wrap: "window.someFlag" }),
      filteredGuard({ wrap: 'GetXFormFieldById("fd_condition")[0].value == "1"' }),
      filteredGuard({ helperSignature: "function removeDeletion(arr,obj,x=doSomething())" }),
      filteredGuard({ helperSignature: "function* removeDeletion(arr,obj)" }),
      filteredGuard({ callbackSignature: "function(x=doSomething())" }),
      filteredGuard({ helperElse: "else { window.sideEffect(); }" }),
      filteredGuard({ alertArgument: "doSomething()" })
    ];

    for (const source of cases) {
      assert.equal(isUnconditionalAttachmentRequirement(source, fieldId), false, source);
    }
  });

  it("keeps a view-only guard review-required even when its callback shape is exact", () => {
    const form = attachmentForm();
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [source(filteredGuard(), "xform:viewShow")]
    }, { form });
    const action = scripts.actions.find((candidate) =>
      candidate.recipe?.kind === "attachment_non_empty"
    );
    const updatedForm = applyStaticScriptProperties(form, scripts);

    assert.equal(action.translationStatus, "needs_review");
    assert.deepEqual(action.runWhen, { viewStatusIn: ["view"] });
    assert.equal(updatedForm.fields[0].props.required, undefined);
  });

  it("does not let review patches forge native-required evidence for a conditional guard", () => {
    const draft = draftSourceDraft(cleanSourceFile(
      "tests/fixtures/source4/19ed50e681ba7fdeab4e00a48dc9da44"
    ));
    const fieldId = "fd_3a4530a5242e44";
    const field = draft.form.fields.find((candidate) => candidate.id === fieldId);
    const action = draft.scripts.actions.find((candidate) =>
      candidate.recipe?.kind === "attachment_non_empty" &&
      candidate.recipe.fieldId === fieldId
    );
    field.props.required = true;
    action.function = "";
    action.translationStatus = "omitted";
    action.coverage = {
      status: "covered",
      nativeRules: [],
      staticProps: [{ fieldId, prop: "required", value: true }],
      residuals: []
    };
    action.functionMappings = [{
      source: "legacy attachment active-file submit guard",
      target: "form.fields[].props.required",
      basis: "static-form-prop",
      reviewRequired: false
    }];

    const result = checkDraft(draft);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((diagnostic) =>
      diagnostic.code === "dsl.scripts.gated_omission_forbidden" &&
      diagnostic.path.endsWith("/translationStatus")
    ), true, JSON.stringify(result.diagnostics));

    delete action.runWhen;
    const ungated = checkDraft(draft);
    assert.equal(ungated.ok, false);
    assert.equal(ungated.diagnostics.some((diagnostic) =>
      diagnostic.code === "dsl.scripts.recipe_attachment_native_required_evidence_required"
    ), true, JSON.stringify(ungated.diagnostics));
  });
});

function source(javascript, displayGate = "xform:editShow") {
  return {
    id: "attachment.script.1",
    sourceRef: "source.form.jsp.attachment.script.1",
    displayGate,
    javascript,
    functionAudit: { matched: [], violations: [{ name: "alert", occurrences: [] }] }
  };
}

function attachmentForm() {
  return {
    fields: [{
      id: fieldId,
      title: "附件",
      type: "attachment",
      componentId: "xform-attach",
      props: {},
      sourceRef: `source.form.control.${fieldId}`
    }]
  };
}

function filteredGuard(options = {}) {
  const helperSignature = options.helperSignature || "function removeDeletion(arr,obj)";
  const callbackSignature = options.callbackSignature || "function()";
  const helperElse = options.helperElse || "";
  const alertArgument = options.alertArgument || '"Attachment is required"';
  const conditionOpen = options.wrap ? `if (${options.wrap}) {` : "";
  const conditionClose = options.wrap ? "}" : "";
  return [
    `${helperSignature} {`,
    "  for (let i=0; i<obj.length; i++) {",
    `    if (obj[i].fileStatus != -1) { arr.push(obj[i]); } ${helperElse}`,
    "  }",
    "}",
    `Com_Parameter.event.submit.push(${callbackSignature} {`,
    `  var attachment = Attachment_ObjectInfo["${fieldId}"].fileList;`,
    "  var active = [];",
    "  removeDeletion(active, attachment);",
    `  ${conditionOpen}`,
    `  if (active.length == 0) { alert(${alertArgument}); return false; }`,
    `  ${conditionClose}`,
    "  return true;",
    "});",
    options.after || ""
  ].join("\n");
}

function directGuard() {
  return [
    "Com_Parameter.event.submit.push(function(){",
    "  var valid = true;",
    `  if (attachmentObject_${fieldId}.fileList.length <= 0) { valid = false; }`,
    "  if (valid) {",
    "    var count = 0;",
    `    for (var i=0; i<attachmentObject_${fieldId}.fileList.length; i++) {`,
    `      if (attachmentObject_${fieldId}.fileList[i].fileStatus > -1) { count++; }`,
    "    }",
    "    if (count == 0) { valid = false; }",
    "  }",
    '  if (!valid) { alert("Attachment is required"); } else { valid = true; }',
    "  return valid;",
    "});"
  ].join("\n");
}
