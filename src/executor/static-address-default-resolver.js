const STAGE = "resolveStaticAddressDefaults";
const ORG_TYPE_BY_NATIVE = new Map([
  ["1", "ORG_TYPE_ORG"],
  ["2", "ORG_TYPE_DEPT"],
  ["4", "ORG_TYPE_POST"],
  ["8", "ORG_TYPE_PERSON"]
]);

export class StaticAddressDefaultResolutionError extends Error {
  constructor(issues) {
    super(`Could not validate ${issues.length} static address default ${issues.length === 1 ? "identity" : "identities"} in current NewOA.`);
    this.name = "StaticAddressDefaultResolutionError";
    this.stage = STAGE;
    this.code = "form.static_address_default_resolution_failed";
    this.issues = issues;
  }
}

export function hasStaticAddressDefaults(dsl) {
  return collectStaticAddressDefaults(dsl).length > 0;
}

export async function resolveStaticAddressDefaults(dsl, { client } = {}) {
  const defaults = collectStaticAddressDefaults(dsl);
  if (!defaults.length) {
    return { dsl, resolvedCount: 0, identityCount: 0 };
  }
  if (typeof client?.getElementInfo !== "function") {
    throw new StaticAddressDefaultResolutionError(defaults.map((entry) => ({
      reason: "client_capability_missing",
      id: entry.value.id,
      name: entry.value.name,
      paths: entry.paths
    })));
  }

  const ids = [...new Set(defaults.map((entry) => entry.value.id))];
  const candidates = await client.getElementInfo(ids);
  const issues = [];
  for (const entry of defaults) {
    const matches = (Array.isArray(candidates) ? candidates : []).filter((candidate) =>
      text(candidate?.fdId) === entry.value.id
    );
    if (matches.length !== 1) {
      issues.push({
        reason: matches.length ? "ambiguous" : "not_found",
        id: entry.value.id,
        name: entry.value.name,
        paths: entry.paths,
        candidateIds: matches.map((candidate) => text(candidate?.fdId)).filter(Boolean)
      });
      continue;
    }
    const target = matches[0];
    if (text(target.fdName) !== entry.value.name) {
      issues.push({
        reason: "name_mismatch",
        id: entry.value.id,
        name: entry.value.name,
        targetName: text(target.fdName),
        paths: entry.paths
      });
      continue;
    }
    const targetOrgType = ORG_TYPE_BY_NATIVE.get(String(target.fdOrgType));
    if (!targetOrgType || !entry.orgTypes.includes(targetOrgType)) {
      issues.push({
        reason: "type_mismatch",
        id: entry.value.id,
        name: entry.value.name,
        targetOrgType: target.fdOrgType,
        allowedOrgTypes: entry.orgTypes,
        paths: entry.paths
      });
    }
  }
  if (issues.length) throw new StaticAddressDefaultResolutionError(issues);
  return {
    dsl,
    resolvedCount: defaults.reduce((sum, entry) => sum + entry.paths.length, 0),
    identityCount: defaults.length
  };
}

function collectStaticAddressDefaults(dsl) {
  const grouped = new Map();
  for (const { field, path } of formFieldEntries(dsl?.form?.fields)) {
    const value = field?.props?.defaultValue;
    if (field?.componentId !== "xform-address" || value?.kind !== "staticOrg") continue;
    const id = text(value.id);
    const name = text(value.name);
    const orgTypes = normalizedOrgTypes(field.props?.orgTypes);
    const key = `${id}\0${name}\0${orgTypes.join(";")}`;
    const current = grouped.get(key);
    if (current) {
      current.paths.push(path);
    } else {
      grouped.set(key, { value: { kind: "staticOrg", id, name }, orgTypes, paths: [path] });
    }
  }
  return [...grouped.values()];
}

function formFieldEntries(fields = []) {
  return (Array.isArray(fields) ? fields : []).flatMap((field, index) =>
    field?.type === "detailTable"
      ? (field.columns || []).map((column, columnIndex) => ({
          field: column,
          path: `/form/fields/${index}/columns/${columnIndex}/props/defaultValue`
        }))
      : [{ field, path: `/form/fields/${index}/props/defaultValue` }]
  );
}

function normalizedOrgTypes(value) {
  const values = Array.isArray(value) && value.length
    ? value
    : ["ORG_TYPE_PERSON", "ORG_TYPE_DEPT"];
  return [...new Set(values.map(text).filter(Boolean))].sort();
}

function text(value) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}
