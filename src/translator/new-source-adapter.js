import { DSL_VERSION } from "../dsl/schema.js";

const TYPE_MAP = new Map([
  ["text", "text"],
  ["string", "text"],
  ["textarea", "longText"],
  ["longText", "longText"],
  ["number", "number"],
  ["date", "date"],
  ["dateTime", "dateTime"],
  ["select", "singleSelect"],
  ["singleSelect", "singleSelect"],
  ["multiSelect", "multiSelect"],
  ["radio", "radio"],
  ["checkbox", "checkbox"],
  ["attachment", "attachment"],
  ["description", "description"]
]);

export function translateNewSource(source, options = {}) {
  if (!isRecord(source)) {
    throw new Error("new source must be a JSON object");
  }

  const warnings = [];
  const fields = Array.isArray(source.fields)
    ? source.fields.map((field, index) => translateField(field, index, warnings))
    : [];

  if (!Array.isArray(source.fields)) {
    warnings.push({
      code: "source.fields_missing",
      message: "Source file does not contain a fields array.",
      path: "/fields"
    });
  }

  return {
    version: DSL_VERSION,
    source: {
      kind: "new-source-json",
      path: options.sourcePath
    },
    template: {
      name: source.templateName || source.processName || "",
      categoryPath: source.categoryPath || ""
    },
    form: {
      fields
    },
    review: {
      warnings
    }
  };
}

function translateField(field, index, warnings) {
  const sourceType = typeof field?.type === "string" ? field.type : "";
  const type = TYPE_MAP.get(sourceType) || "text";

  if (!TYPE_MAP.has(sourceType)) {
    warnings.push({
      code: "source.field_type_unknown",
      message: "Unknown source field type was mapped to text.",
      path: `/fields/${index}/type`,
      details: { current: sourceType || null }
    });
  }

  return {
    id: field?.id || field?.name || `field_${index + 1}`,
    title: field?.title || field?.label || field?.name || `Field ${index + 1}`,
    type,
    required: field?.required === true,
    ...(Array.isArray(field?.options) ? { options: normalizeOptions(field.options) } : {})
  };
}

function normalizeOptions(options) {
  return options
    .map((option) => {
      if (typeof option === "string") {
        return { label: option, value: option };
      }
      return {
        label: String(option?.label || option?.name || option?.value || ""),
        value: String(option?.value || option?.label || option?.name || "")
      };
    })
    .filter((option) => option.label && option.value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
