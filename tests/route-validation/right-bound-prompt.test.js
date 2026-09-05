import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture =
  "tests/fixtures/source/1684f9b552170cab50d0cd04231954b9/1684fa994ca99291085162b4f8781908_SysFormTemplate.xml";
const sameCellFixture =
  "tests/fixtures/route-validation/right-bound-prompt/right-bound-prompt_SysFormTemplate.xml";

const rightPromptCases = [
  ["fd_36faa7ebf3d15c", "fd_36fac63f605a72", "fd_36fac637de804e", "用人部门意见"],
  ["fd_36faa7ec6aedd8", "fd_36fac7df282378", "fd_36fac7d0fa0c22", "会审部门意见"],
  ["fd_36faa7ecf758c6", "fd_36fac7dfe0bfc0", "fd_36fac7d2af68ea", "会审部门意见"],
  ["fd_36fc4fc16e9c36", "fd_36fc4fe2bc0aea", "fd_36fc4fdcd7d2e4", undefined],
  ["fd_3716db09cc2d84", "fd_3716db34636d30", "fd_3716db3f8bd314", undefined],
  ["fd_36faa7ed6cea70", "fd_36fac7e0dd1aae", "fd_36fac7d49c650e", "会审部门意见"],
  ["fd_36faa7edbb3f40", "fd_36fac7e1b9153a", "fd_36fac7d5f5c16a", "会审部门意见"],
  ["fd_36faa7ee10f8c0", "fd_36fac7e2753bac", "fd_36fac7d79231e2", "人力资源部意见"],
  ["fd_3917349c5f8f2a", "fd_391734a5e11c8e", "fd_391734ad54fe56", undefined],
  ["fd_36faa809844f90", "fd_36fac7e338e266", "fd_36fac7db1e888e", "资产财务部意见"]
].map(([promptId, inputId, rightId, rightName]) => ({
  promptId,
  inputId,
  rightId,
  rightName
}));

const ordinaryBindings = [
  ["fd_36faa5d97b5c6c", "fd_36faa5e632f34a"],
  ["fd_3c85c50dff504c", "fd_3c85c512a65054"],
  ["fd_38471a3c15f414", "fd_38471a4e209df8"]
].map(([captionId, inputId]) => ({ captionId, inputId }));

describe("right-bound prompt Route-validation", () => {
  it("preserves all ten external prompts, keeps right titles, and hides every right-input label", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const sourceControls = new Map(
      sourceDraft.form.controls.map((control) => [control.id, control])
    );
    const targetFields = new Map(
      dslDraft.form.fields.map((field) => [field.id, field])
    );
    const externalInputs = sourceDraft.form.controls.filter((control) =>
      control.sourceProps?.boundCaption?.relation === "external-right-prompt"
    );

    assert.deepEqual(
      externalInputs.map((control) => control.id).sort(),
      rightPromptCases.map((testCase) => testCase.inputId).sort()
    );
    assert.equal(rightPromptCases.filter((testCase) => testCase.rightName).length, 7);
    assert.equal(rightPromptCases.filter((testCase) => !testCase.rightName).length, 3);

    for (const testCase of rightPromptCases) {
      const prompt = sourceControls.get(testCase.promptId);
      const input = sourceControls.get(testCase.inputId);
      const targetPrompt = targetFields.get(testCase.promptId);
      const targetInput = targetFields.get(testCase.inputId);

      assert.deepEqual(
        {
          sourceType: prompt?.sourceType,
          designerType: prompt?.sourceProps?.designerType,
          targetType: targetPrompt?.type,
          componentId: targetPrompt?.componentId
        },
        {
          sourceType: "description",
          designerType: "textLabel",
          targetType: "description",
          componentId: "xform-description"
        },
        `prompt ${testCase.promptId}`
      );
      assert.deepEqual(
        input?.sourceProps?.rightContainer,
        {
          id: testCase.rightId,
          ...(testCase.rightName ? { name: testCase.rightName } : {})
        },
        `input ${testCase.inputId}`
      );
      assert.equal(
        input?.sourceProps?.boundCaption?.id,
        testCase.promptId,
        `bound prompt ${testCase.inputId}`
      );
      assert.equal(targetInput?.componentId, "xform-input", `component ${testCase.inputId}`);
      assert.equal(
        targetInput?.title,
        testCase.rightName || testCase.inputId,
        `title ${testCase.inputId}`
      );
      assert.equal(
        targetInput?.props?.hiddenLabel,
        true,
        `hidden label ${testCase.inputId}`
      );

      const sourcePromptOwner = sourceOwner(sourceDraft.form.layout, testCase.promptId);
      const sourceInputOwner = sourceOwner(sourceDraft.form.layout, testCase.inputId);
      assert.equal(sourcePromptOwner?.rowId, sourceInputOwner?.rowId, `source row ${testCase.inputId}`);
      assert.ok(
        sourcePromptOwner?.column < sourceInputOwner?.column,
        `source prompt precedes input ${testCase.inputId}`
      );

      const targetPromptOwner = targetOwner(dslDraft.form.layout.mkTree, testCase.promptId);
      const targetInputOwner = targetOwner(dslDraft.form.layout.mkTree, testCase.inputId);
      assert.equal(targetPromptOwner?.rowId, targetInputOwner?.rowId, `target row ${testCase.inputId}`);
      assert.ok(
        targetPromptOwner?.column < targetInputOwner?.column,
        `target prompt precedes input ${testCase.inputId}`
      );
    }

    assert.deepEqual(
      sourceDraft.form.layout.rows
        .find((row) => row.id === "row-5")
        ?.cells.flatMap((cell) =>
          cell.references.map((reference) => reference.referenceId)
        ),
      ["fd_36faa7e63165da", "fd_36faa7ebf3d15c", "fd_36fac63f605a72"]
    );
    assert.deepEqual(
      dslDraft.form.layout.mkTree
        .find((row) => row.id === "layout.row-5")
        ?.children.flatMap((child) => child.refIds),
      ["fd_36faa7e63165da", "fd_36faa7ebf3d15c", "fd_36fac63f605a72"]
    );

    const validation = validateMigrationDsl(dslDraft, { mode: "draft" });
    assert.equal(validation.ok, true);
    assert.equal(
      validation.diagnostics.filter((diagnostic) => diagnostic.level === "error").length,
      0
    );
  });

  it("continues folding ordinary label bindings instead of treating them as right prompts", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const sourceControls = new Map(
      sourceDraft.form.controls.map((control) => [control.id, control])
    );
    const targetFields = new Map(
      dslDraft.form.fields.map((field) => [field.id, field])
    );

    for (const { captionId, inputId } of ordinaryBindings) {
      const input = sourceControls.get(inputId);
      assert.equal(input?.sourceProps?.boundCaption?.id, captionId);
      assert.equal(
        input?.sourceProps?.boundCaption?.relation,
        "explicit-label-bind-id"
      );
      assert.equal(input?.sourceProps?.rightContainer, undefined);
      assert.equal(sourceControls.get(captionId)?.sourceType, "description");
      assert.equal(targetFields.get(captionId)?.componentId, "xform-description");
      if (targetFields.get(inputId)?.componentId === "xform-datetime") {
        assert.equal(targetFields.get(inputId)?.sourceProps?.layoutCell?.hiddenLabel, true);
        assert.equal(targetFields.get(inputId)?.props?.hiddenLabel, undefined);
      } else {
        assert.equal(targetFields.get(inputId)?.props?.hiddenLabel, true);
      }
    }
  });

  it("does not fold an external right prompt when prompt and input share one cell", () => {
    const sourceDraft = cleanSourceFile(sameCellFixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const sourceIds = sourceDraft.form.controls.map((control) => control.id);
    const targetFields = new Map(
      dslDraft.form.fields.map((field) => [field.id, field])
    );

    assert.deepEqual(sourceIds.slice(0, 2), ["external_prompt", "fd_right_decision"]);
    assert.equal(targetFields.get("external_prompt")?.componentId, "xform-description");
    assert.equal(targetFields.get("fd_right_decision")?.title, "Department decision");
    assert.equal(targetFields.get("fd_right_decision")?.props?.hiddenLabel, true);
    assert.deepEqual(
      dslDraft.form.layout.mkTree[0].children.flatMap((child) => child.refIds),
      ["external_prompt", "fd_right_decision"]
    );
  });

  it("does not apply the right-title policy to an explicitly inactive label binding", () => {
    const dslDraft = draftSourceDraft(cleanSourceFile(sameCellFixture));
    const fields = new Map(dslDraft.form.fields.map((field) => [field.id, field]));

    assert.equal(fields.get("inactive_prompt")?.componentId, "xform-description");
    assert.equal(fields.get("fd_inactive_binding")?.title, "Include in cost");
    assert.equal(fields.get("fd_inactive_binding")?.props?.hiddenLabel, undefined);
  });

  it("uses the same right-input hidden-label policy for a textarea", () => {
    const dslDraft = draftSourceDraft(cleanSourceFile(sameCellFixture));
    const fields = new Map(dslDraft.form.fields.map((field) => [field.id, field]));

    assert.equal(fields.get("textarea_prompt")?.componentId, "xform-description");
    assert.equal(fields.get("fd_right_notes")?.componentId, "xform-textarea");
    assert.equal(fields.get("fd_right_notes")?.title, "fd_right_notes");
    assert.equal(fields.get("fd_right_notes")?.props?.hiddenLabel, true);
  });
});

function sourceOwner(layout, fieldId) {
  for (const row of layout.rows || []) {
    for (const cell of row.cells || []) {
      if ((cell.references || []).some((reference) => reference.referenceId === fieldId)) {
        return { rowId: row.id, column: cell.column };
      }
    }
  }
  return undefined;
}

function targetOwner(rows, fieldId) {
  for (const row of rows || []) {
    for (const child of row.children || []) {
      if ((child.refIds || []).includes(fieldId)) {
        return { rowId: row.id, column: child.column };
      }
    }
  }
  return undefined;
}
