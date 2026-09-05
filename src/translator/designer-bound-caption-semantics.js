import { cleanText } from "./xml-utils.js";

export function isZeroWidthAddressDisplayCompanion(control, controls) {
  if (designerType(control) !== "inputtext") return false;
  return controls.some((address) =>
    isZeroWidthAddressControl(address) && isAddressDisplayCompanion(control, address)
  );
}

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

function isZeroWidthAddressControl(control) {
  return designerType(control) === "address" &&
    Number(control.source?.designerValues?.width) === 0;
}

function isAddressDisplayCompanion(control, address) {
  const controlValues = control?.source?.designerValues || {};
  const addressValues = address?.source?.designerValues || {};
  return control?.id === `${address?.id}.name` &&
    Boolean(controlValues._label_bind_id) &&
    controlValues._label_bind_id === addressValues._label_bind_id;
}

function designerType(control) {
  return String(control?.source?.designerType || "").toLowerCase();
}
