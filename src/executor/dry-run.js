import { checkExecute } from "../dsl/checks.js";
import { summarizeFormRules } from "../dsl/form-rules.js";
import { summarizeScriptActionSupport } from "../dsl/scripts.js";

export function buildDryRunPlan(input) {
  const validation = checkExecute(input);
  const templateName = input?.template?.name || "";
  const fields = Array.isArray(input?.form?.fields) ? input.form.fields : [];
  const dataOnlyFieldCount = fields.filter((field) => field?.dataOnly === true).length;
  const renderedFieldCount = fields.length - dataOnlyFieldCount;
  const layoutRows = Array.isArray(input?.form?.layout?.mkTree) ? input.form.layout.mkTree : [];
  const layout = summarizeLayoutGraph(layoutRows);
  const scriptActions = Array.isArray(input?.scripts?.actions) ? input.scripts.actions : [];
  const scriptSupport = summarizeScriptActionSupport(scriptActions, input?.form);
  const formRuleSummary = summarizeFormRules(input?.formRules);
  const formRuleSteps = formRuleSummary.sourceRuleCount ? [{
    id: "map-form-rules",
    action: "map-formRules-linkage-to-newoa-native-formRule",
    status: validation.ok ? "planned" : "blocked",
    ...formRuleSummary
  }] : [];
  const scriptSteps = scriptActions.length ? [{
    id: "map-form-scripts",
    action: "map-jsp-scripts-to-newoa-control-actions",
    status: validation.ok ? "planned" : "blocked",
    actions: scriptActions.length,
    events: scriptActions.map((action) => action.event || action.name).filter(Boolean),
    support: scriptSupport.counts,
    components: scriptSupport.components,
    detailActions: scriptSupport.detailActions
  }] : [];
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
        dataOnlyFieldCount,
        renderedFieldCount,
        layoutRows: layout.rootCount,
        layoutRootCount: layout.rootCount,
        layoutNodeCount: layout.nodeCount,
        nestedLayoutCount: layout.nestedCount
      },
      ...formRuleSteps,
      ...scriptSteps,
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
        expectedDataOnlyFieldCount: dataOnlyFieldCount,
        expectedRenderedFieldCount: renderedFieldCount,
        expectedLayoutRows: layout.rootCount,
        expectedLayoutRootCount: layout.rootCount,
        expectedLayoutNodeCount: layout.nodeCount,
        expectedNestedLayoutCount: layout.nestedCount
      }
    ]
  };
}

function summarizeLayoutGraph(nodes = []) {
  const nodeIds = new Set(nodes.map((node) => node?.id).filter(Boolean));
  const referenced = new Set(
    nodes.flatMap((node) =>
      (node?.children || [])
        .filter((cell) => cell?.refType === "layout")
        .flatMap((cell) => cell.refIds || [])
    ).filter((nodeId) => nodeIds.has(nodeId))
  );
  const rootCount = nodes.filter((node) => nodeIds.has(node?.id) && !referenced.has(node.id)).length;
  return {
    rootCount,
    nodeCount: nodeIds.size,
    nestedCount: Math.max(0, nodeIds.size - rootCount)
  };
}
