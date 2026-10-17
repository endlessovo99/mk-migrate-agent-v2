// The only added detail width is the caller-approved, persisted advice column.
// Ordinary source widths do not acquire this capability through editable props.
export function approvedDetailColumnWidths(table = {}) {
  const widths = {};
  for (const field of table.columns || []) {
    const policy = field.sourceProps?.approvedRuntimePolicy;
    if (field.generated !== true || field.componentId !== "xform-input" || field.type !== "text" ||
        field.title !== "卡号检查" || !field.reason || field.props?.readOnly !== true || field.props?.required !== false ||
        field.props?.defaultValue?.kind !== "literal" || field.props.defaultValue.value !== "" ||
        policy?.kind !== "detail-card-number-advice-column" || policy.derivedValuePersistence !== true ||
        !policy.sourceActionId || policy.sourceRef !== field.sourceRef || !/^sha256:[a-f0-9]{64}$/.test(policy.sourceJavascriptSha256 || "") ||
        field.sourceProps?.designerValues?.width !== "260") continue;
    widths[field.id] = 260;
  }
  return widths;
}
