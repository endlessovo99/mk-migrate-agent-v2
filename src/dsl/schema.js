export const DSL_VERSION = "2.0-draft";

export const FIELD_TYPES = new Set([
  "text",
  "longText",
  "number",
  "date",
  "dateTime",
  "singleSelect",
  "multiSelect",
  "radio",
  "checkbox",
  "attachment",
  "description"
]);

export function validateMigrationDsl(input) {
  const diagnostics = [];
  const root = isRecord(input) ? input : {};

  if (!isRecord(input)) {
    diagnostics.push(error("dsl.root_type", "DSL must be a JSON object.", "/"));
  }

  if (root.version !== DSL_VERSION) {
    diagnostics.push(error("dsl.version_unsupported", `DSL version must be ${DSL_VERSION}.`, "/version", {
      current: root.version,
      supported: [DSL_VERSION]
    }));
  }

  const template = isRecord(root.template) ? root.template : {};
  if (!nonEmptyString(template.name)) {
    diagnostics.push(error("dsl.template.name_required", "template.name is required.", "/template/name"));
  }

  const form = isRecord(root.form) ? root.form : {};
  if (!Array.isArray(form.fields) || form.fields.length === 0) {
    diagnostics.push(error("dsl.form.fields_required", "form.fields must contain at least one field.", "/form/fields"));
  } else {
    validateFields(form.fields, diagnostics);
  }

  const warnings = Array.isArray(root.review?.warnings) ? root.review.warnings : [];
  for (const warning of warnings) {
    diagnostics.push({
      level: "warning",
      code: warning.code || "dsl.review.warning",
      message: warning.message || "DSL contains a review warning.",
      path: warning.path || "/review/warnings",
      details: warning.details
    });
  }

  const hasErrors = diagnostics.some((item) => item.level === "error");
  const hasWarnings = diagnostics.some((item) => item.level === "warning");

  return {
    ok: !hasErrors,
    status: hasErrors ? "invalid" : hasWarnings ? "needs_manual" : "ok",
    diagnostics,
    dsl: root
  };
}

function validateFields(fields, diagnostics) {
  const ids = new Set();

  fields.forEach((field, index) => {
    const path = `/form/fields/${index}`;
    if (!isRecord(field)) {
      diagnostics.push(error("dsl.field.type", "Field must be a JSON object.", path));
      return;
    }

    if (!nonEmptyString(field.id)) {
      diagnostics.push(error("dsl.field.id_required", "Field id is required.", `${path}/id`));
    } else if (ids.has(field.id)) {
      diagnostics.push(error("dsl.field.id_duplicate", "Field id must be unique.", `${path}/id`, { id: field.id }));
    } else {
      ids.add(field.id);
    }

    if (!nonEmptyString(field.title)) {
      diagnostics.push(error("dsl.field.title_required", "Field title is required.", `${path}/title`));
    }

    if (!FIELD_TYPES.has(field.type)) {
      diagnostics.push(error("dsl.field.type_unsupported", "Field type is not supported by the v2 draft DSL.", `${path}/type`, {
        current: field.type,
        supported: Array.from(FIELD_TYPES)
      }));
    }

    if (field.options !== undefined) {
      if (!Array.isArray(field.options)) {
        diagnostics.push(error("dsl.field.options_type", "Field options must be an array.", `${path}/options`));
      } else if (["singleSelect", "multiSelect", "radio", "checkbox"].includes(field.type)) {
        field.options.forEach((option, optionIndex) => {
          if (!nonEmptyString(option?.label) || !nonEmptyString(option?.value)) {
            diagnostics.push(error("dsl.field.option_invalid", "Option label and value are required.", `${path}/options/${optionIndex}`));
          }
        });
      }
    }
  });
}

function error(code, message, path, details) {
  return {
    level: "error",
    code,
    message,
    path,
    details
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
