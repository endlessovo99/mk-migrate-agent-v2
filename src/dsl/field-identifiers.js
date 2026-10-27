/** Target identities only. Dots in source evidence and qualified references are allowed. */
export function dottedFieldIdDiagnostics(form) {
  const diagnostics = [];
  function inspect(field, path) {
    if (typeof field?.id === "string" && field.id.includes(".")) {
      diagnostics.push({
        level: "error",
        code: "dsl.field.id_contains_dot",
        message: "Target field IDs must not contain '.'. Regenerate the DSL to remap the field and all of its references.",
        path: `${path}/id`,
        details: { id: field.id }
      });
    }
    if (Array.isArray(field?.columns)) {
      field.columns.forEach((column, index) => inspect(column, `${path}/columns/${index}`));
    }
  }
  if (Array.isArray(form?.fields)) {
    form.fields.forEach((field, index) => inspect(field, `/form/fields/${index}`));
  }
  return diagnostics;
}
