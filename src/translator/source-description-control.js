export function isSourceDescriptionControl(control) {
  const designerType = String(control?.source?.designerType || "").toLowerCase();
  return control?.type === "description" || ["textlabel", "linklabel"].includes(designerType);
}

export function isStyledSourceDescriptionControl(control) {
  if (!isSourceDescriptionControl(control)) return false;
  const values = control?.source?.designerValues || {};
  if (hasNonDefaultTextColor(values.color) || isTrueLike(values.b)) return true;
  const style = String(values.style || "");
  if (/color\s*:\s*#(?!000000|000\b)[0-9a-f]{3,8}\b/i.test(style)) return true;
  if (/font-weight\s*:\s*(bold|[6-9]00)\b/i.test(style)) return true;
  return false;
}

function hasNonDefaultTextColor(value) {
  const color = String(value || "").trim();
  if (!color) return false;
  const normalized = color.toLowerCase();
  return !["#000", "#000000", "black", "rgb(0,0,0)", "rgba(0,0,0,1)"].includes(normalized);
}

function isTrueLike(value) {
  return ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());
}
