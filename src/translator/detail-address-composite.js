export function foldLegacyDetailAddressComposites(form) {
  return {
    ...form,
    fields: (form.fields || []).map((field) => {
      if (field.type !== "detailTable") return field;
      return {
        ...field,
        columns: foldCompositeColumns(field.columns || [])
      };
    })
  };
}

function foldCompositeColumns(columns) {
  const groups = new Map();
  for (const column of columns) {
    const groupKey = compositeGroupKey(column);
    if (!groupKey) continue;
    const group = groups.get(groupKey) || [];
    group.push(column);
    groups.set(groupKey, group);
  }

  const replacements = new Map();
  for (const [groupKey, group] of groups) {
    if (group.length !== 2) continue;
    const address = group.find((column) =>
      column.componentId === "xform-address" &&
      isZeroDesignerWidth(column.sourceProps?.designerValues?.width)
    );
    const display = group.find((column) =>
      column.componentId === "xform-input" &&
      column.type === "text" &&
      hasPositiveDesignerWidth(column.sourceProps?.designerValues?.width)
    );
    if (!address || !display || address === display) continue;

    const required = address.props?.required === true || display.props?.required === true;
    const displayProps = { ...(display.props || {}) };
    delete displayProps.required;
    const memberIds = group.map((column) => column.id);
    replacements.set(display.id, {
      ...display,
      props: displayProps,
      dataOnly: true,
      sourceProps: withCompositeEvidence(display.sourceProps, {
        groupKey,
        role: "stored_display_shadow",
        memberIds,
        interactiveFieldId: address.id
      })
    });
    replacements.set(address.id, {
      ...address,
      props: {
        ...(address.props || {}),
        ...(required ? { required: true } : {})
      },
      sourceProps: withCompositeEvidence(address.sourceProps, {
        groupKey,
        role: "interactive_address",
        memberIds,
        storedDisplayFieldId: display.id
      })
    });
  }

  return columns.map((column) => replacements.get(column.id) || column);
}

function compositeGroupKey(column) {
  const header = column.sourceProps?.detailHeaderCaption;
  const headerId = String(header?.id || "").trim();
  const title = String(column.title || "").replace(/\s+/gu, "").toLowerCase();
  if (
    !headerId ||
    header?.relation !== "same-detail-column-header" ||
    !title ||
    column.dataOnly === true
  ) {
    return "";
  }
  return `${headerId}:${title}`;
}

function isZeroDesignerWidth(value) {
  return /^0(?:\.0+)?(?:px|%|em|rem)?$/iu.test(String(value ?? "").trim());
}

function hasPositiveDesignerWidth(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+(?:\.\d+)?(?:px|%|em|rem)?$/iu.test(normalized)) return false;
  return Number.parseFloat(normalized) > 0;
}

function withCompositeEvidence(sourceProps, evidence) {
  return {
    ...(sourceProps || {}),
    legacyDetailComposite: evidence
  };
}
