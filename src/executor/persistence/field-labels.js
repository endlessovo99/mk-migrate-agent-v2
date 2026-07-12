export const NEWOA_FIELD_LABEL_MAX_LENGTH = 200;

/** Keep native designer labels within NewOA's persisted metadata bound. */
export function persistedFieldLabel(field) {
  const label = String(field?.title ?? "");
  if (field?.type !== "description" && field?.componentId !== "xform-description") return label;
  const characters = [...label];
  if (characters.length <= NEWOA_FIELD_LABEL_MAX_LENGTH) return label;
  return `${characters.slice(0, NEWOA_FIELD_LABEL_MAX_LENGTH - 1).join("")}…`;
}
