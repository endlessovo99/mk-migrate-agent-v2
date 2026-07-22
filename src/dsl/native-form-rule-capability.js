import { MK_FORM_RULE_RUNTIME_CATALOG } from "./catalogs.js";

export const NATIVE_FORM_RULE_FORMULA_CAPABILITY = Object.freeze(
  activeFormulaCapability(MK_FORM_RULE_RUNTIME_CATALOG)
);

export function nativeFormRuleProjectionRef() {
  return {
    kind: NATIVE_FORM_RULE_FORMULA_CAPABILITY.projection.kind,
    version: NATIVE_FORM_RULE_FORMULA_CAPABILITY.projection.version
  };
}

function activeFormulaCapability(catalog) {
  const capability = Array.isArray(catalog?.capabilities)
    ? catalog.capabilities.find((candidate) => candidate?.id === catalog?.activeCapabilityId)
    : undefined;
  const projection = capability?.projection;
  const runtime = capability?.modules?.runtime;
  const ide = capability?.modules?.ide;
  if (
    !capability ||
    !nonEmptyString(projection?.kind) ||
    !Number.isInteger(projection?.version) ||
    !nonEmptyString(projection?.displayGate) ||
    !nonEmptyString(projection?.trigger) ||
    !nonEmptyString(projection?.conditionSource) ||
    !Array.isArray(projection?.viewStatusIn) ||
    !projection.viewStatusIn.length ||
    !Array.isArray(projection?.operators) ||
    !Array.isArray(projection?.transforms) ||
    !Array.isArray(projection?.predicates) ||
    [runtime, ide].some((module) => (
      !nonEmptyString(module?.digestKey) ||
      !nonEmptyString(module?.path) ||
      !nonEmptyString(module?.release) ||
      !nonEmptyString(module?.sha256)
    ))
  ) {
    throw new Error("The active MK form-rule runtime capability catalog entry is invalid.");
  }
  return {
    ...capability,
    catalogId: catalog.id,
    catalogVersion: catalog.version
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
