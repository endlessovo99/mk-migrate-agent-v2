export function resolveDesignerVisibilityOverrides({
  fieldId,
  canShowHidden,
  runtimeVisibleFieldIds = new Set(),
  nodeDataAuthorityVisibleFieldIds = new Set()
}) {
  const displayJsp = Boolean(
    fieldId && canShowHidden && runtimeVisibleFieldIds.has(fieldId)
  );
  const nodeDataAuthority = Boolean(
    fieldId && canShowHidden && nodeDataAuthorityVisibleFieldIds.has(fieldId)
  );
  return {
    displayJsp,
    nodeDataAuthority,
    ignoreCanShow: displayJsp || nodeDataAuthority
  };
}

export function designerVisibilityWarnings(fields = []) {
  return fields.flatMap((field) => {
    const warnings = [];
    if (field.source?.displayJspVisibilityOverride === true) {
      warnings.push({
        code: "source.sysform.display_jsp_visibility_override",
        message: `Designer field ${field.id} (${field.title}) is rendered unconditionally by fdDisplayJsp and will remain visible despite canShow=false.`,
        path: "/fdDisplayJsp",
        details: {
          fieldId: field.id,
          designerCanShow: false,
          displayJspRendered: true
        }
      });
    }
    if (field.source?.nodeDataAuthorityVisibilityOverride === true) {
      warnings.push({
        code: "source.sysform.node_data_authority_visibility_override",
        message: `Designer field ${field.id} (${field.title}) is visible on at least one workflow node and will remain in the form layout despite canShow=false.`,
        path: "/fdDesignerHtml",
        details: {
          fieldId: field.id,
          designerCanShow: false,
          nodeDataAuthorityVisible: true
        }
      });
    }
    return warnings;
  });
}
