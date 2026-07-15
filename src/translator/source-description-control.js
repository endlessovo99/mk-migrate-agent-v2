export function isSourceDescriptionControl(control) {
  const designerType = String(control?.source?.designerType || "").toLowerCase();
  return control?.type === "description" || ["textlabel", "linklabel"].includes(designerType);
}
