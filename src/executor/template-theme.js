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
  const descriptions = descriptionLabels(config);
  const detailColumns = new Map((config.dataModel || []).filter((model) => model.fdType === "detail")
    .map((model) => [model.fdTableName, (model.fdFields || [])
      .filter((field) => !field.fdIsSystem && field.fdDisplay !== false).map((field) => field.fdName)]));
  const expected = config.viewModel.map((viewModel) => {
    const view = JSON.parse(viewModel.fdConfig);
    view.theme = structuredClone(preset.theme);
    applyClassicThemeChrome(view, descriptions);
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
          if (!classicThemeChromeMatches(current, descriptionLabels(formConfig(actualTemplate)))) {
            diagnostics.push(mismatch(`${path}/view`, "theme-chrome"));
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

function descriptionLabels(config) {
  const labels = new Map();
  for (const model of config.dataModel || []) {
    for (const field of model.fdFields || []) {
      if (!field.fdAttribute) continue;
      const attribute = JSON.parse(field.fdAttribute);
      if (attribute.config?.type !== "desc") continue;
      labels.set(field.fdName, typeof attribute.config.label === "string" ? attribute.config.label : "");
    }
  }
  return labels;
}

const BORDER_KEYS = ["borderTop", "borderLeft", "borderRight", "borderBottom"];

// The theme object alone does not paint the designer canvas. Desktop grid items
// carry the visible borders and caption backgrounds, and the appearance node
// carries the title and background.
function applyClassicThemeChrome(view, labels) {
  const desktopAttr = preset.theme.desktop.viewAttr;
  const mobileAttr = preset.theme.mobile.viewAttr;
  for (const node of view.view?.render?.desktop || []) {
    if (node?.type !== "@elem/xform-appearance") continue;
    node.controlProps = {
      ...(node.controlProps || {}),
      titleInfo: structuredClone(desktopAttr.formTitle),
      backgroundSetting: structuredClone(desktopAttr.backgroundSetting)
    };
  }
  for (const node of view.view?.render?.mobile || []) {
    if (node?.type !== "@elem/xform-appearance") continue;
    const controlProps = { ...(node.controlProps || {}), titleInfo: structuredClone(mobileAttr.formTitle) };
    delete controlProps.backgroundSetting;
    node.controlProps = controlProps;
  }
  stampDesktopGridBorders(view.view?.render?.desktop, labels);
}

function stampDesktopGridBorders(nodes, labels) {
  for (const node of nodes || []) {
    if (node?.type === "@elem/layout-grid") {
      const columns = node.controlProps?.columns;
      const rows = node.controlProps?.rows;
      const border = preset.theme.desktop.viewAttr.desktopGridItemStyle;
      for (const item of node.children || []) {
        if (item?.type !== "@elem/layout-grid.GridItem") continue;
        item.controlProps = item.controlProps || {};
        item.controlProps.style = classicGridItemStyle(item.controlProps, columns, rows, border);
        const caption = captionLabelBackground(item, labels);
        if (caption) item.controlProps.style.backgroundColor = caption;
      }
    }
    stampDesktopGridBorders(node?.children, labels);
  }
}

const CAPTION_LABEL_LIMIT = 40;

function captionLabelBackground(item, labels) {
  const ids = fieldRefs(item);
  if (ids.length === 0 || !ids.every((id) => labels?.has(id))) return undefined;
  const text = ids.map((id) => labels.get(id) || "").join("");
  if (!text || text.length > CAPTION_LABEL_LIMIT || text.includes("\n")) return undefined;
  return preset.theme.desktop.viewAttr.desktopTitleBgColor;
}

function fieldRefs(node, ids = []) {
  if (typeof node?.key === "string" && !node.type && !node.kind) ids.push(node.key);
  for (const child of node?.children || []) fieldRefs(child, ids);
  return ids;
}

function classicGridItemStyle(props, columns, rows, border) {
  const style = { ...(props.style || {}) };
  if (style.backgroundColor == null || style.backgroundColor === "") style.backgroundColor = "";
  style.borderTop = border.borderTop;
  style.borderLeft = border.borderLeft;
  if (reachesEdge(props.column, props.columnSpan, columns)) style.borderRight = border.borderRight;
  else delete style.borderRight;
  if (reachesEdge(props.row, props.rowSpan, rows)) style.borderBottom = border.borderBottom;
  else delete style.borderBottom;
  return style;
}

function reachesEdge(start, span, extent) {
  const size = Number.isInteger(span) && span >= 1 ? span : 1;
  if (!Number.isInteger(extent)) return true;
  if (!Number.isInteger(start)) return true;
  return start + size - 1 >= extent;
}

function classicThemeChromeMatches(view, labels) {
  return appearanceMatches(view, "desktop") && appearanceMatches(view, "mobile") &&
    desktopGridBordersMatch(view, labels) && mobileGridBordersClear(view);
}

function appearanceMatches(view, scene) {
  const node = (view.view?.render?.[scene] || []).find((item) => item?.type === "@elem/xform-appearance");
  const attr = preset.theme[scene].viewAttr;
  if (!contains(node?.controlProps?.titleInfo, attr.formTitle)) return false;
  if (scene === "desktop") return contains(node.controlProps.backgroundSetting, attr.backgroundSetting);
  return node.controlProps.backgroundSetting == null;
}

function desktopGridBordersMatch(view, labels) {
  let matches = true;
  const labelBackground = preset.theme.desktop.viewAttr.desktopTitleBgColor;
  visitGrids(view.view?.render?.desktop, (grid) => {
    const border = preset.theme.desktop.viewAttr.desktopGridItemStyle;
    for (const item of grid.children || []) {
      if (item?.type !== "@elem/layout-grid.GridItem") continue;
      const expected = classicGridItemStyle(item.controlProps || {}, grid.controlProps?.columns, grid.controlProps?.rows, border);
      const caption = captionLabelBackground(item, labels);
      if (caption) expected.backgroundColor = caption;
      if (!borderStyleMatches(item.controlProps?.style, expected)) matches = false;
      const background = item.controlProps?.style?.backgroundColor ?? "";
      if (caption && background !== caption) matches = false;
      if (!caption && background === labelBackground) matches = false;
    }
  });
  return matches;
}

function mobileGridBordersClear(view) {
  let clear = true;
  visitGrids(view.view?.render?.mobile, (grid) => {
    for (const item of grid.children || []) {
      if (item?.type !== "@elem/layout-grid.GridItem") continue;
      if (BORDER_KEYS.some((key) => presentBorder(item.controlProps?.style?.[key]) !== undefined)) clear = false;
    }
  });
  return clear;
}

function visitGrids(nodes, visit) {
  for (const node of nodes || []) {
    if (node?.type === "@elem/layout-grid") visit(node);
    visitGrids(node?.children, visit);
  }
}

function borderStyleMatches(actual = {}, expected) {
  if ((actual.backgroundColor ?? "") !== (expected.backgroundColor ?? "")) return false;
  return BORDER_KEYS.every((key) => presentBorder(actual[key]) === expected[key]);
}

function presentBorder(value) {
  return value === "" || value === undefined ? undefined : value;
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
