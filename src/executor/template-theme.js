import { readFileSync } from "node:fs";

const preset = JSON.parse(readFileSync(new URL("../../catalogs/mk-classic-theme.v1.json", import.meta.url), "utf8"));
export const REQUIRED_TEMPLATE_THEME = Object.freeze({ desktop: "classic", mobile: "classic" });

// Only the normal new-draft executor applies this policy to a write payload.
// Repair paths may use the returned verifier without writing the projection.
export function prepareRequiredTemplateTheme(template) {
  const update = structuredClone(template);
  const config = formConfig(update);
  if (!Array.isArray(config.viewModel) || config.viewModel.length === 0) {
    throw new TypeError("Template theme projection requires a form view.");
  }
  const descriptions = new Set((config.dataModel || []).flatMap((model) => (
    (model.fdFields || []).filter((field) => (
      field.fdAttribute && JSON.parse(field.fdAttribute).config?.type === "desc"
    )).map((field) => field.fdName)
  )));
  const detailColumns = new Map((config.dataModel || []).filter((model) => model.fdType === "detail")
    .map((model) => [model.fdTableName, (model.fdFields || [])
      .filter((field) => !field.fdIsSystem && field.fdDisplay !== false).map((field) => field.fdName)]));
  const expected = config.viewModel.map((viewModel) => {
    const view = JSON.parse(viewModel.fdConfig);
    view.theme = structuredClone(preset.theme);
    view.controlStyle = view.controlStyle || {};
    for (const scene of Object.keys(REQUIRED_TEMPLATE_THEME)) {
      const ids = renderedControlIds(view.view?.render?.[scene]);
      for (const id of [...ids]) {
        // Native views can omit detail children and let the model render them.
        for (const column of detailColumns.get(id) || []) ids.add(column);
      }
      for (const id of ids) {
        const existing = view.controlStyle[id] || {};
        const defaults = structuredClone(preset.controlStyle[scene]);
        // Description colors and emphasis are source content, not theme defaults.
        // Leaving absent colors unset also preserves persisted form invariants.
        if (descriptions.has(id)) {
          defaults.layout = "vertical";
          delete defaults.controlValueStyle;
        }
        const sourceStyle = scene === "mobile" && descriptions.has(id)
          ? { controlValueStyle: existing.desktop?.controlValueStyle || {} }
          : {};
        view.controlStyle[id] = {
          ...existing,
          [scene]: {
            ...mergeStyle(defaults, mergeStyle(sourceStyle, existing[scene] || {})),
            [`${scene}Theme`]: "classic"
          }
        };
      }
    }
    viewModel.fdConfig = JSON.stringify(view);
    return { fdCode: viewModel.fdCode, theme: view.theme, controlStyle: view.controlStyle };
  });
  update.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  return {
    update,
    verify(readback, actualTemplate) {
      const diagnostics = [];
      try {
        const actual = formConfig(actualTemplate).viewModel;
        if (!Array.isArray(actual) || actual.length !== expected.length) {
          throw new TypeError("Form view count changed.");
        }
        expected.forEach((view, index) => {
          const current = JSON.parse(actual[index].fdConfig);
          const path = `/mechanisms/sys-xform/fdConfig/viewModel/${index}`;
          if (actual[index].fdCode !== view.fdCode) diagnostics.push(mismatch(path, "view-identity"));
          if (!contains(current.theme, view.theme)) diagnostics.push(mismatch(`${path}/theme`, "theme"));
          if (!contains(current.controlStyle, view.controlStyle)) {
            diagnostics.push(mismatch(`${path}/controlStyle`, "control-style"));
          }
        });
      } catch {
        diagnostics.push(mismatch("/mechanisms/sys-xform/fdConfig/viewModel", "invalid-view"));
      }
      const ok = readback.ok && diagnostics.length === 0;
      return {
        ...readback,
        ok,
        status: ok ? readback.status : "readback_failed",
        theme: {
          contractVersion: preset.version,
          status: diagnostics.length === 0 ? "verified" : "mismatch",
          ...REQUIRED_TEMPLATE_THEME
        },
        diagnostics: [...(readback.diagnostics || []), ...diagnostics]
      };
    }
  };
}

function formConfig(template) {
  return JSON.parse(template.mechanisms["sys-xform"].fdConfig);
}

function renderedControlIds(nodes = [], ids = new Set()) {
  for (const node of nodes) {
    // Native references use the generated table name for detail containers and
    // actual field names for main controls and detail columns.
    if (typeof node.key === "string" && !node.type && !node.kind) ids.add(node.key);
    renderedControlIds(node.children || [], ids);
  }
  return ids;
}

function mergeStyle(defaults, explicit) {
  const result = structuredClone(defaults);
  for (const [key, value] of Object.entries(explicit)) {
    result[key] = object(value) && object(result[key])
      ? mergeStyle(result[key], value)
      : structuredClone(value);
  }
  return result;
}

function contains(actual, expected) {
  if (!object(expected)) return actual === expected;
  return object(actual) && Object.entries(expected).every(([key, value]) => contains(actual[key], value));
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mismatch(path, reason) {
  return {
    level: "error",
    code: "readback.theme.mismatch",
    partition: "theme",
    path,
    message: "Readback must retain the classic theme and projected styles on desktop and mobile.",
    details: { reason, expected: REQUIRED_TEMPLATE_THEME }
  };
}
