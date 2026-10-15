// A source permission restriction is independent of the target component.
export function sourceRequiresReadOnly(field = {}) {
  const props = field.sourceProps || {};
  if (isDesignerTrue(props.designerValues?.readOnly)) return true;
  if (props.runtimeTextReadOnly?.readOnly === true) return true;
  const sqlTextReadOnly = props.designerValues?.txtReadOnly;
  return String(props.designerType || "").toLowerCase() === "sqldialog" &&
    (sqlTextReadOnly === true ||
      (typeof sqlTextReadOnly === "string" && isDesignerTrue(sqlTextReadOnly)));
}

function isDesignerTrue(value) {
  return String(value).trim().toLowerCase() === "true";
}
