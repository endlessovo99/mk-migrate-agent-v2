const RECIPE_KINDS = new Set([
  "dependent_select_options",
  "attachment_non_empty",
  "detail_row_control_state",
  "detail_row_lifecycle"
]);

export function scriptRecipeValidationIssues(action, context = {}) {
  if (action.recipe === undefined) return [];
  const issues = [];
  const add = (code, message, pathSuffix, details) => {
    issues.push({ code, message, pathSuffix, details });
  };
  const recipe = action.recipe;
  if (!isRecord(recipe) || !nonEmptyString(recipe.kind)) {
    add("dsl.scripts.recipe_invalid", "Script recipe must be an object with a supported kind.", "/recipe");
    return issues;
  }

  const fieldById = new Map((context.form?.fields || []).map((field) => [field.id, field]));
  const detailById = new Map((context.form?.fields || [])
    .filter((field) => field?.type === "detailTable")
    .map((field) => [field.id, field]));
  if (!RECIPE_KINDS.has(recipe.kind)) {
    add(
      "dsl.scripts.recipe_kind_unsupported",
      "Script recipe kind is not supported by the executor contract.",
      "/recipe/kind",
      { kind: recipe.kind }
    );
    return issues;
  }

  if (recipe.kind === "dependent_select_options") {
    const trigger = fieldById.get(recipe.triggerFieldId);
    const target = fieldById.get(recipe.targetFieldId);
    if (!trigger || trigger.type === "detailTable") {
      add("dsl.scripts.recipe_trigger_missing", "Dependent-options recipe triggerFieldId must reference a main form field.", "/recipe/triggerFieldId");
    }
    if (!target || target.componentId !== "xform-select") {
      add("dsl.scripts.recipe_target_invalid", "Dependent-options recipe targetFieldId must reference an xform-select field.", "/recipe/targetFieldId");
    }
    if (!Array.isArray(recipe.cases) || !recipe.cases.length || !Array.isArray(recipe.defaultOptions)) {
      add("dsl.scripts.recipe_options_required", "Dependent-options recipe requires cases[] and defaultOptions[].", "/recipe");
    }
  }

  if (recipe.kind === "attachment_non_empty") {
    if (fieldById.get(recipe.fieldId)?.type !== "attachment") {
      add("dsl.scripts.recipe_attachment_missing", "Attachment non-empty recipe must reference an attachment field.", "/recipe/fieldId");
    }
    if (action.event !== "onBeforeSubmit") {
      add("dsl.scripts.recipe_event_invalid", "Attachment non-empty recipe must run onBeforeSubmit.", "/event");
    }
    if (!nonEmptyString(recipe.message)) {
      add("dsl.scripts.recipe_message_required", "Attachment non-empty recipe requires a user-visible validation message.", "/recipe/message");
    }
  }

  if (["detail_row_control_state", "detail_row_lifecycle"].includes(recipe.kind)) {
    const table = detailById.get(recipe.tableId);
    const columnIds = new Set((table?.columns || []).map((column) => column.id));
    if (!table || !columnIds.has(recipe.triggerControlId) || !columnIds.has(recipe.targetControlId)) {
      add("dsl.scripts.recipe_detail_target_invalid", "Detail-row recipe must reference one detail table and existing trigger/target columns.", "/recipe");
    }
    if (recipe.hiddenControlId && !columnIds.has(recipe.hiddenControlId)) {
      add("dsl.scripts.recipe_detail_hidden_missing", "Detail-row recipe hiddenControlId must reference a column in the same detail table.", "/recipe/hiddenControlId");
    }
    if (recipe.kind === "detail_row_lifecycle" && !completeRowLifecycle(recipe.rowLifecycle)) {
      add(
        "dsl.scripts.recipe_detail_lifecycle_incomplete",
        "Detail-row lifecycle recipe must explicitly cover existing, added, and deleted rows plus obsolete legacy DOM cleanup.",
        "/recipe/rowLifecycle"
      );
    }
  }
  return issues;
}

function completeRowLifecycle(value) {
  return isRecord(value) &&
    value.existingRows === "on_load_initialization" &&
    value.addedRows === "native_detail_control_event" &&
    value.deletedRows === "native_detail_runtime" &&
    value.legacyDomCleanup === "not_applicable_native_runtime";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
