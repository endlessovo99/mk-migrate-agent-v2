import { checkExecute } from "../dsl/checks.js";

export function buildDryRunPlan(input) {
  const validation = checkExecute(input);
  const templateName = input?.template?.name || "";
  const fields = Array.isArray(input?.form?.fields) ? input.form.fields : [];
  const layoutRows = Array.isArray(input?.form?.layout?.mkTree) ? input.form.layout.mkTree : [];
  const workflow = input?.workflow;
  const workflowSteps = workflow ? [{
    id: "map-workflow",
    action: "map-trusted-workflow-to-newoa-payload",
    status: validation.ok ? "planned" : "blocked",
    nodes: Array.isArray(workflow.nodes) ? workflow.nodes.length : 0,
    edges: Array.isArray(workflow.edges) ? workflow.edges.length : 0
  }] : [];

  return {
    ok: validation.ok,
    status: validation.status,
    diagnostics: validation.diagnostics,
    validationPolicy: input?.validationPolicy,
    catalogs: input?.catalogs,
    trust: input?.trust,
    template: {
      name: templateName,
      categoryPath: input?.template?.categoryPath || ""
    },
    steps: [
      {
        id: "check-execute",
        action: "check execute",
        status: validation.ok ? "ok" : "invalid"
      },
      {
        id: "resolve-template",
        action: "api.create-new-test-template",
        status: validation.ok ? "planned" : "blocked",
        target: templateName,
        safety: "SIT-only MK_TEST draft"
      },
      {
        id: "map-form-layout",
        action: "map-trusted-mkTree-to-newoa-form-payload",
        status: validation.ok ? "planned" : "blocked",
        fieldCount: fields.length,
        layoutRows: layoutRows.length
      },
      ...workflowSteps,
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
        expectedFieldCount: fields.length,
        expectedLayoutRows: layoutRows.length
      }
    ]
  };
}
