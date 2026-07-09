import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const COMPONENT_CATALOG = loadCatalog("catalogs/mk-components.v1.json");
export const CONTROL_EVENTS_CATALOG = loadCatalog("catalogs/mk-control-events.v1.json");
export const FUNCTION_CATALOG = loadCatalog("catalogs/functions.v1.json");
export const JS_METHOD_CATALOG = loadCatalog("catalogs/js-methods.v1.json");
export const MK_JS_SNIPPETS_CATALOG = loadCatalog("catalogs/mk-js-snippets.v1.json");
export const VALIDATION_POLICY = loadCatalog("catalogs/validation-policy.v1.json");

export const CATALOG_VERSIONS = {
  components: COMPONENT_CATALOG.version,
  controlEvents: CONTROL_EVENTS_CATALOG.version,
  functions: FUNCTION_CATALOG.version,
  jsMethods: JS_METHOD_CATALOG.version,
  targetApis: MK_JS_SNIPPETS_CATALOG.version
};

export const VALIDATION_POLICY_VERSION = VALIDATION_POLICY.version;

export const COMPONENTS_BY_ID = new Map(
  COMPONENT_CATALOG.components.map((component) => [component.componentId, component])
);

export const CONTROL_EVENTS_BY_COMPONENT = new Map(
  CONTROL_EVENTS_CATALOG.components.map((component) => [component.componentId, component])
);

export const FUNCTIONS_BY_NAME = new Map(
  FUNCTION_CATALOG.functions.map((fn) => [fn.name, fn])
);

export function componentCatalogRef() {
  return {
    id: COMPONENT_CATALOG.id,
    version: COMPONENT_CATALOG.version
  };
}

export function functionCatalogRef() {
  return {
    id: FUNCTION_CATALOG.id,
    version: FUNCTION_CATALOG.version
  };
}

export function controlEventsCatalogRef() {
  return {
    id: CONTROL_EVENTS_CATALOG.id,
    version: CONTROL_EVENTS_CATALOG.version
  };
}

export function jsMethodCatalogRef() {
  return {
    id: JS_METHOD_CATALOG.id,
    version: JS_METHOD_CATALOG.version
  };
}

export function targetApiCatalogRef() {
  return {
    id: MK_JS_SNIPPETS_CATALOG.id,
    version: MK_JS_SNIPPETS_CATALOG.version
  };
}

export function validationPolicyRef() {
  return {
    id: VALIDATION_POLICY.id,
    version: VALIDATION_POLICY.version
  };
}

export function catalogRefs() {
  return {
    components: componentCatalogRef(),
    controlEvents: controlEventsCatalogRef(),
    functions: functionCatalogRef(),
    jsMethods: jsMethodCatalogRef(),
    targetApis: targetApiCatalogRef()
  };
}

export function validateCatalogVersions(root, diagnostics, path = "") {
  if (root?.catalogs?.components?.version !== COMPONENT_CATALOG.version) {
    diagnostics.push(error("catalog.components.version_mismatch", "DSL component catalog version must match the runtime catalog.", `${path}/catalogs/components/version`, {
      expected: COMPONENT_CATALOG.version,
      actual: root?.catalogs?.components?.version
    }));
  }

  if (root?.catalogs?.functions?.version !== FUNCTION_CATALOG.version) {
    diagnostics.push(error("catalog.functions.version_mismatch", "DSL function catalog version must match the runtime catalog.", `${path}/catalogs/functions/version`, {
      expected: FUNCTION_CATALOG.version,
      actual: root?.catalogs?.functions?.version
    }));
  }

  if (root?.catalogs?.controlEvents && root.catalogs.controlEvents.version !== CONTROL_EVENTS_CATALOG.version) {
    diagnostics.push(error("catalog.control_events.version_mismatch", "DSL control-events catalog version must match the runtime catalog.", `${path}/catalogs/controlEvents/version`, {
      expected: CONTROL_EVENTS_CATALOG.version,
      actual: root.catalogs.controlEvents.version
    }));
  }

  if (root?.catalogs?.jsMethods && root.catalogs.jsMethods.version !== JS_METHOD_CATALOG.version) {
    diagnostics.push(error("catalog.js_methods.version_mismatch", "DSL JS-method catalog version must match the runtime catalog.", `${path}/catalogs/jsMethods/version`, {
      expected: JS_METHOD_CATALOG.version,
      actual: root.catalogs.jsMethods.version
    }));
  }

  if (root?.catalogs?.targetApis && root.catalogs.targetApis.version !== MK_JS_SNIPPETS_CATALOG.version) {
    diagnostics.push(error("catalog.target_apis.version_mismatch", "DSL target API catalog version must match the runtime catalog.", `${path}/catalogs/targetApis/version`, {
      expected: MK_JS_SNIPPETS_CATALOG.version,
      actual: root.catalogs.targetApis.version
    }));
  }

  if (root?.validationPolicy?.version !== VALIDATION_POLICY.version) {
    diagnostics.push(error("validation_policy.version_mismatch", "DSL validation-policy version must match the runtime policy.", `${path}/validationPolicy/version`, {
      expected: VALIDATION_POLICY.version,
      actual: root?.validationPolicy?.version
    }));
  }
}

export function validateComponentProps({ componentId, props, scope, path }, diagnostics) {
  if (!nonEmptyString(componentId)) {
    diagnostics.push(error("catalog.component_id_required", "componentId is required.", `${path}/componentId`));
    return undefined;
  }

  const component = COMPONENTS_BY_ID.get(componentId);
  if (!component) {
    diagnostics.push(error("catalog.component_unknown", "componentId is not in the MK component catalog.", `${path}/componentId`, {
      componentId,
      supported: [...COMPONENTS_BY_ID.keys()]
    }));
    return undefined;
  }

  if (scope && !component.allowedScopes.includes(scope)) {
    diagnostics.push(error("catalog.component_scope_invalid", "componentId is not allowed in this DSL scope.", `${path}/componentId`, {
      componentId,
      scope,
      allowedScopes: component.allowedScopes
    }));
  }

  validateSchema(props ?? {}, component.propsSchema, diagnostics, `${path}/props`, {
    componentId,
    defs: COMPONENT_CATALOG.$defs || {}
  });

  return component;
}

export function validateFunctionCatalogAudit(functionAudit, diagnostics, path = "/review/functionWhitelist") {
  if (!functionAudit) return;
  const violations = Array.isArray(functionAudit.violations) ? functionAudit.violations : [];
  for (const violation of violations) {
    diagnostics.push(error("catalog.function_unsupported", "Source function is not in the versioned function catalog.", path, {
      functionName: violation.name,
      occurrences: violation.occurrences || []
    }));
  }
}

function validateSchema(value, schema, diagnostics, path, context) {
  if (!schema) return;

  if (schema.$ref) {
    const refName = schema.$ref.replace("#/$defs/", "");
    validateSchema(value, context.defs[refName], diagnostics, path, context);
    return;
  }

  if (Array.isArray(schema.anyOf)) {
    const branchDiagnostics = [];
    for (const branch of schema.anyOf) {
      const next = [];
      validateSchema(value, branch, next, path, context);
      if (!next.length) return;
      branchDiagnostics.push(next);
    }
    diagnostics.push(error("catalog.props.value_invalid", "Prop value does not match any allowed schema branch.", path, {
      componentId: context.componentId,
      failures: branchDiagnostics.map((items) => items.map((item) => item.code))
    }));
    return;
  }

  if (schema.type === "object") {
    if (!isRecord(value)) {
      diagnostics.push(error("catalog.props.type_invalid", "Props must be an object.", path, {
        componentId: context.componentId,
        expected: "object",
        actual: typeName(value)
      }));
      return;
    }
    const properties = schema.properties || {};
    for (const key of Object.keys(value)) {
      if (!properties[key] && schema.additionalProperties === false) {
        diagnostics.push(error("catalog.props.unknown", "Prop is not allowed by the component catalog.", `${path}/${escapePointer(key)}`, {
          componentId: context.componentId,
          prop: key
        }));
        continue;
      }
      validateSchema(value[key], properties[key], diagnostics, `${path}/${escapePointer(key)}`, context);
    }
    for (const requiredKey of schema.required || []) {
      if (!Object.hasOwn(value, requiredKey)) {
        diagnostics.push(error("catalog.props.required", "Required prop is missing.", `${path}/${escapePointer(requiredKey)}`, {
          componentId: context.componentId,
          prop: requiredKey
        }));
      }
    }
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      diagnostics.push(error("catalog.props.type_invalid", "Prop must be an array.", path, {
        componentId: context.componentId,
        expected: "array",
        actual: typeName(value)
      }));
      return;
    }
    value.forEach((item, index) => validateSchema(item, schema.items, diagnostics, `${path}/${index}`, context));
    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      diagnostics.push(typeError(path, context.componentId, "string", value));
      return;
    }
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      diagnostics.push(error("catalog.props.value_invalid", "String prop is shorter than the catalog minimum.", path, {
        componentId: context.componentId,
        minLength: schema.minLength
      }));
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      diagnostics.push(enumError(path, context.componentId, schema.enum, value));
    }
    return;
  }

  if (schema.type === "boolean") {
    if (typeof value !== "boolean") diagnostics.push(typeError(path, context.componentId, "boolean", value));
    return;
  }

  if (schema.type === "integer") {
    if (!Number.isInteger(value)) {
      diagnostics.push(typeError(path, context.componentId, "integer", value));
      return;
    }
    validateNumberRange(value, schema, diagnostics, path, context.componentId);
    return;
  }

  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      diagnostics.push(typeError(path, context.componentId, "number", value));
      return;
    }
    validateNumberRange(value, schema, diagnostics, path, context.componentId);
  }
}

function validateNumberRange(value, schema, diagnostics, path, componentId) {
  if (Number.isFinite(schema.minimum) && value < schema.minimum) {
    diagnostics.push(error("catalog.props.value_invalid", "Numeric prop is lower than the catalog minimum.", path, {
      componentId,
      minimum: schema.minimum,
      actual: value
    }));
  }
  if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) {
    diagnostics.push(error("catalog.props.value_invalid", "Numeric prop must be greater than the catalog minimum.", path, {
      componentId,
      exclusiveMinimum: schema.exclusiveMinimum,
      actual: value
    }));
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    diagnostics.push(enumError(path, componentId, schema.enum, value));
  }
}

function typeError(path, componentId, expected, value) {
  return error("catalog.props.type_invalid", "Prop type does not match the component catalog.", path, {
    componentId,
    expected,
    actual: typeName(value)
  });
}

function enumError(path, componentId, allowed, actual) {
  return error("catalog.props.value_invalid", "Prop value is not allowed by the component catalog.", path, {
    componentId,
    allowed,
    actual
  });
}

function loadCatalog(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), "utf8"));
}

function error(code, message, path, details) {
  return {
    level: "error",
    code,
    message,
    path,
    details
  };
}

function escapePointer(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function typeName(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}
