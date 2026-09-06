import { componentSupportsProp } from "../dsl/catalogs.js";

/**
 * Maps a legacy address display-name companion onto MK's single address
 * control while retaining the companion as persisted, non-rendered data.
 * This is target selection and therefore belongs at the DSL mapping seam.
 */
export function mapAddressDisplayCompanions(fields, sourceLayout) {
  const companions = addressCompanions(fields, sourceLayout);
  if (!companions.size) return fields;

  const companionByAddressId = new Map(
    [...companions].map(([companionId, addressId]) => [
      addressId,
      fields.find((field) => field.id === companionId)
    ])
  );
  return fields.map((field) => {
    const companion = companionByAddressId.get(field.id);
    if (companion) {
      return {
        ...field,
        props: {
          ...field.props,
          ...(field.props?.required === true || companion.props?.required === true
            ? { required: true }
            : {}),
          ...(
            shouldHideAddressLabel(field, companion) &&
            componentSupportsProp(field.componentId, "hiddenLabel")
              ? { hiddenLabel: true }
              : {}
          )
        },
        sourceProps: {
          ...field.sourceProps,
          addressDisplayCompanionId: companion.id,
          ...(companion.sourceProps?.layoutCell
            ? { layoutCell: companion.sourceProps.layoutCell }
            : {})
        }
      };
    }
    if (!companions.has(field.id)) return field;
    const { required: _required, ...props } = field.props || {};
    return {
      ...field,
      props,
      dataOnly: true,
      sourceProps: {
        ...field.sourceProps,
        addressDisplayFor: companions.get(field.id)
      }
    };
  });
}

export function removeDataOnlyFieldRefs(layout, fields) {
  const dataOnlyIds = new Set(
    fields.filter((field) => field.dataOnly === true).map((field) => field.id)
  );
  const geometryPreservingDataOnlyIds = new Set(
    fields
      .filter((field) =>
        field.dataOnly === true &&
        field.sourceProps?.presentation === "shared-caption-robot-output"
      )
      .map((field) => field.id)
  );
  return {
    ...(layout || {}),
    rows: (layout?.rows || []).map((row) => {
      const cells = (row.cells || []).map((cell) => ({
        ...cell,
        references: (cell.references || []).filter((reference) =>
          !dataOnlyIds.has(reference.referenceId)
        )
      })).filter((cell) =>
        (cell.references || []).length > 0 || (cell.layoutRowIds || []).length > 0
      );
      const removedGeometryPreservingField = (row.cells || []).some((cell) =>
        (cell.references || []).length > 1 &&
        (cell.references || []).some((reference) =>
          geometryPreservingDataOnlyIds.has(reference.referenceId)
        )
      );
      return {
        ...row,
        ...(removedGeometryPreservingField ? { preserveSourceGeometry: true } : {}),
        cells
      };
    })
  };
}

function shouldHideAddressLabel(address, companion) {
  return companion.props?.hiddenLabel === true ||
    companion.sourceProps?.layoutCell?.hiddenLabel === true ||
    address.sourceProps?.layoutCell?.hiddenLabel === true;
}

function addressCompanions(fields, layout) {
  const companions = new Map();
  for (const address of fields) {
    if (!isZeroWidthAddress(address)) continue;
    const companion = fields.find((field) => isDisplayCompanion(field, address));
    if (!companion || !shareLayoutCell(layout, companion.id, address.id)) continue;
    companions.set(companion.id, address.id);
  }
  return companions;
}

function isZeroWidthAddress(field) {
  return field?.componentId === "xform-address" &&
    Number(field.sourceProps?.designerValues?.width) === 0;
}

function isDisplayCompanion(field, address) {
  const fieldValues = field?.sourceProps?.designerValues || {};
  const addressValues = address?.sourceProps?.designerValues || {};
  return field?.id === `${address?.id}.name` &&
    field?.componentId === "xform-input" &&
    Boolean(fieldValues._label_bind_id) &&
    fieldValues._label_bind_id === addressValues._label_bind_id;
}

function shareLayoutCell(layout, leftId, rightId) {
  return (layout?.rows || []).some((row) => (row.cells || []).some((cell) => {
    const ids = new Set((cell.references || []).map((reference) => reference.referenceId));
    return ids.has(leftId) && ids.has(rightId);
  }));
}
