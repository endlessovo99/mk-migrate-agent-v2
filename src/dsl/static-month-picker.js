export function isSourceBackedMonthField(field) {
  const inference = field?.sourceProps?.monthPickerInference;
  return field?.type === "dateTime" &&
    field?.componentId === "xform-datetime" &&
    field?.props?.dataPattern === "yyyy-MM" &&
    field?.props?.displayPattern === "yyyy-MM" &&
    inference?.classification === "source" &&
    inference?.dataPattern === "yyyy-MM" &&
    inference?.displayPattern === "yyyy-MM";
}
