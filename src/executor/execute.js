import { buildDryRunPlan } from "./dry-run.js";

export async function executeDsl(input, options = {}) {
  const plan = buildDryRunPlan(input);

  if (!plan.ok) {
    return {
      ok: false,
      status: "invalid",
      diagnostics: plan.diagnostics,
      plan
    };
  }

  if (options.confirmWrite !== true) {
    return {
      ok: false,
      status: "blocked",
      diagnostics: [{
        level: "error",
        code: "safety.confirm_write_required",
        message: "execute requires --confirm-write.",
        path: "/confirmWrite"
      }],
      plan
    };
  }

  return {
    ok: false,
    status: "not_implemented",
    diagnostics: [{
      level: "error",
      code: "execute.api_spike_required",
      message: "NewOA API write execution is intentionally not implemented until the API spike is proven.",
      path: "/execute"
    }],
    plan
  };
}
