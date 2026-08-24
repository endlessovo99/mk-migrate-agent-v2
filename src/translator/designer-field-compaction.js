import { cleanText } from "./xml-utils.js";

/**
 * A legacy zero-width address picker writes the selected display name through
 * a visible `<addressId>.name` text input. MK's address control owns both the
 * selected identity and its display value, so the text companion remains a
 * persisted data field but must not consume a second layout slot.
 */
export function compactAddressDisplayCompanions(designer) {
  const fields = Array.isArray(designer?.fields) ? designer.fields : [];
  const companions = addressCompanions(fields, designer?.layout);
  if (!companions.size) return designer;

  const companionByAddressId = new Map(
    [...companions].map(([companionId, addressId]) => [
      addressId,
      fields.find((field) => field.id === companionId)
    ])
  );
  return {
    ...designer,
    fields: fields
      .filter((field) => !companions.has(field.id))
      .map((field) => companionByAddressId.has(field.id)
        ? {
            ...field,
            required: field.required === true || companionByAddressId.get(field.id)?.required === true,
            source: {
              ...field.source,
              addressDisplayCompanionId: companionByAddressId.get(field.id)?.id
            }
          }
        : field),
    hiddenFields: [
      ...(designer.hiddenFields || []),
      ...fields
        .filter((field) => companions.has(field.id))
        .map((field) => ({
          ...field,
          required: false,
          source: {
            ...field.source,
            designerHidden: true,
            addressDisplayFor: companions.get(field.id)
          }
        }))
    ],
    layout: {
      ...(designer.layout || {}),
      rows: (designer.layout?.rows || []).map((row) => ({
        ...row,
        cells: (row.cells || []).map((cell) => compactCell(cell, companions))
          .filter((cell) =>
            (cell.fieldIds || []).length > 0 || (cell.layoutRowIds || []).length > 0
          )
      }))
    }
  };
}

export function isZeroWidthAddressDisplayCompanion(control, controls) {
  if (designerType(control) !== "inputtext") return false;
  return controls.some((address) =>
    isZeroWidthAddressControl(address) && isAddressDisplayCompanion(control, address)
  );
}

/**
 * A required field inside an unnamed right container still represents the
 * ordinary bound field. Named right containers and optional decision inputs
 * retain the separate external prompt semantics.
 */
export function isCompactRequiredRightBoundControl(control) {
  const values = control?.source?.designerValues || {};
  const right = control?.source?.rightContainer;
  return Boolean(
    right?.id &&
    !cleanText(right.name || "") &&
    control?.required === true &&
    String(values._label_bind || "").toLowerCase() === "true" &&
    ["textarea", "inputtext"].includes(designerType(control))
  );
}

function addressCompanions(fields, layout) {
  const companions = new Map();
  for (const address of fields) {
    if (!isZeroWidthAddressControl(address)) continue;
    const companion = fields.find((field) => isAddressDisplayCompanion(field, address));
    if (!companion || !shareLayoutCell(layout, companion.id, address.id)) continue;
    companions.set(companion.id, address.id);
  }
  return companions;
}

function compactCell(cell, companions) {
  const fieldIds = (cell.fieldIds || []).filter((fieldId) => !companions.has(fieldId));
  return {
    ...cell,
    fieldIds,
    ...(companions.has(cell.fieldId) ? { fieldId: fieldIds[0] } : {})
  };
}

function isZeroWidthAddressControl(control) {
  return designerType(control) === "address" &&
    Number(control.source?.designerValues?.width) === 0;
}

function isAddressDisplayCompanion(control, address) {
  const controlValues = control?.source?.designerValues || {};
  const addressValues = address?.source?.designerValues || {};
  return control?.id === `${address?.id}.name` &&
    String(controlValues._label_bind || "").toLowerCase() !== "true" &&
    Boolean(controlValues._label_bind_id) &&
    controlValues._label_bind_id === addressValues._label_bind_id;
}

function shareLayoutCell(layout, leftId, rightId) {
  return (layout?.rows || []).some((row) => (row.cells || []).some((cell) => {
    const ids = new Set(cell.fieldIds || []);
    return ids.has(leftId) && ids.has(rightId);
  }));
}

function designerType(control) {
  return String(control?.source?.designerType || "").toLowerCase();
}
