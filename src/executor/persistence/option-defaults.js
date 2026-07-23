export function normalizeOptionDefaultValue(value, options = []) {
  const values = Array.isArray(value) ? value : [value];
  const optionValues = new Map(
    options.map((option) => {
      const optionValue = option?.value ?? option?.label ?? option?.text;
      return [normalizeOptionValue(optionValue), optionValue];
    })
  );
  const normalized = values.map((candidate) => (
    optionValues.get(normalizeOptionValue(candidate)) ?? candidate
  ));
  return Array.isArray(value) ? normalized : normalized[0];
}

export function normalizeOptionValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : value;
}

export function optionValueSet(value) {
  const values = Array.isArray(value) ? value : [value];
  return new Set(values.map(normalizeOptionValue));
}

export function isOptionComponent(componentId) {
  return ["xform-radio", "xform-checkbox", "xform-select", "xform-select~multi"].includes(componentId);
}
