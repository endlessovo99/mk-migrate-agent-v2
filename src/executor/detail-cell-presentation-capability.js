import { parse } from "acorn";
import { DETAIL_CELL_PRESENTATION_CAPABILITY as contract } from "../dsl/detail-cell-presentation-capability.js";
import { inspectDetailVisibilityRuntime } from "./detail-visibility-runtime.js";

export async function inspectDetailCellPresentationRuntime(client, baseUrl, { sdk: verifiedSdk } = {}) {
  if (baseUrl !== contract.origin) return { ok: false, issues: ["origin_unverified"] };
  if (typeof client?.getDetailCellElementRegistry !== "function" || typeof client?.getDetailCellAssetSha256 !== "function") {
    return { ok: false, issues: ["native_asset_read_api_missing"] };
  }
  try {
    const sdk = verifiedSdk || await inspectDetailVisibilityRuntime(client, baseUrl);
    if (!sdk.ok) return { ok: false, issues: sdk.issues.map(issue => `sdk_${issue}`) };
    const releases = inspectRegistry(await client.getDetailCellElementRegistry());
    const issues = Object.entries(contract.releases).filter(([name, expected]) => releases.get(name) !== expected)
      .map(([name]) => `release_unverified:${name}`);
    if (issues.length) return { ok: false, issues };
    const hashes = await Promise.all(Object.keys(contract.assets).map(path => client.getDetailCellAssetSha256({ assetPath: path })));
    Object.entries(contract.assets).forEach(([path, expected], index) => {
      if (hashes[index] !== expected) issues.push(`asset_unverified:${path}`);
    });
    return { ok: issues.length === 0, issues };
  } catch {
    return { ok: false, issues: ["native_asset_read_failed"] };
  }
}

export function inspectRegistry(source) {
  if (typeof source !== "string" || source.length > 10_000_000) throw new Error("Invalid native element registry.");
  const ast = parse(source, { ecmaVersion: "latest" }), found = new Map(), wanted = contract.releases;
  let assignments = 0, references = 0;
  const member = (node, name) => node?.type === "MemberExpression" &&
    (node.computed ? node.property?.type === "Literal" && node.property.value === name : node.property?.type === "Identifier" && node.property.name === name);
  const registryTarget = node => member(node, "sys/artifact") && member(node.object, "moduleDigest") &&
    node.object.object?.type === "Identifier" && node.object.object.name === "APP_CONFIG";
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (registryTarget(node)) references++;
    if (node.type === "AssignmentExpression" && registryTarget(node.left)) {
      assignments++;
      if (assignments !== 1 || node.operator !== "=" || node.right?.type !== "ObjectExpression" ||
          node.right.properties.some(item => item.type !== "Property" || item.computed || item.kind !== "init")) {
        throw new Error("Ambiguous native element registry.");
      }
      for (const property of node.right.properties) {
        const key = property.key?.value ?? property.key?.name;
        if (!Object.hasOwn(wanted, key)) continue;
        if (property.value?.type !== "ObjectExpression" || property.value.properties.some(item =>
          item.type !== "Property" || item.computed || item.kind !== "init")) throw new Error("Ambiguous native element entry.");
        const hashes = (property.value?.properties || []).filter(item => (item.key?.name ?? item.key?.value) === "hash");
        if (found.has(key) || hashes.length !== 1 || hashes[0].value?.type !== "Literal" || typeof hashes[0].value.value !== "string") {
          throw new Error("Ambiguous native element registry.");
        }
        found.set(key, hashes[0].value.value);
      }
    }
    for (const value of Object.values(node)) if (value && typeof value === "object") {
      if (Array.isArray(value)) value.forEach(visit); else visit(value);
    }
  }
  visit(ast);
  if (assignments !== 1 || references !== 1) throw new Error("Missing or mutable native element registry.");
  return found;
}
