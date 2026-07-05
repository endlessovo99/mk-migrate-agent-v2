import { validateMigrationDsl } from "../dsl/schema.js";

export function buildDryRunPlan(input) {
  const validation = validateMigrationDsl(input);
  const templateName = input?.template?.name || "";
  const fields = Array.isArray(input?.form?.fields) ? input.form.fields : [];

  return {
    ok: validation.ok,
    status: validation.status,
    diagnostics: validation.diagnostics,
    template: {
      name: templateName,
      categoryPath: input?.template?.categoryPath || ""
    },
    steps: [
      {
        id: "validate-dsl",
        action: "validate",
        status: validation.ok ? "ok" : "invalid"
      },
      {
        id: "resolve-template",
        action: "api.resolve-or-create-template",
        status: validation.ok ? "planned" : "blocked",
        target: templateName
      },
      {
        id: "map-fields",
        action: "map-dsl-fields-to-newoa-payload",
        status: validation.ok ? "planned" : "blocked",
        count: fields.length
      },
      {
        id: "save-template-draft",
        action: "api.save-template-draft",
        status: validation.ok ? "planned" : "blocked",
        safety: "requires confirmWrite"
      },
      {
        id: "readback",
        action: "api.readback-template",
        status: validation.ok ? "planned" : "blocked",
        expectedFieldCount: fields.length
      }
    ]
  };
}
