import { NATIVE_OTHER_DISPLAY_CAPABILITY as contract } from "../dsl/native-other-display-capability.js";
import { inspectRegistry } from "./detail-cell-presentation-capability.js";

export async function inspectNativeOtherDisplayRuntime(client, baseUrl) {
  if (baseUrl !== contract.origin) return { ok: false, issues: ["origin_unverified"] };
  if (typeof client?.getDetailCellElementRegistry !== "function" || typeof client?.getNativeOtherAssetSha256 !== "function") {
    return { ok: false, issues: ["native_asset_read_api_missing"] };
  }
  try {
    const releases = inspectRegistry(await client.getDetailCellElementRegistry(), contract.releases);
    const issues = Object.entries(contract.releases).filter(([name, value]) => releases.get(name) !== value)
      .map(([name]) => `release_unverified:${name}`);
    if (issues.length) return { ok: false, issues };
    const hashes = await Promise.all(Object.keys(contract.assets).map(assetPath => client.getNativeOtherAssetSha256({ assetPath })));
    Object.entries(contract.assets).forEach(([path, expected], index) => {
      if (hashes[index] !== expected) issues.push(`asset_unverified:${path}`);
    });
    return { ok: issues.length === 0, issues };
  } catch { return { ok: false, issues: ["native_asset_read_failed"] }; }
}
