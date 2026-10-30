import { CHOICE_OTHER_STORAGE_CAPABILITY as contract } from "../dsl/choice-other-storage-capability.js";

/** Verify both client bundles before any migration write can depend on their ABI. */
export async function inspectChoiceOtherStorageRuntime(client, baseUrl) {
  const issues = [];
  if (baseUrl !== contract.origin) return { ok: false, issues: ["origin_unverified"] };
  if (typeof client?.getXFormDesktopDigest !== "function" ||
      typeof client?.getXFormMobileDigest !== "function" ||
      typeof client?.getXFormDesktopModuleSha256 !== "function") {
    return { ok: false, issues: ["runtime_read_api_missing"] };
  }
  try {
    const digests = {
      desktop: await client.getXFormDesktopDigest(),
      mobile: await client.getXFormMobileDigest()
    };
    for (const [platform, expected] of Object.entries(contract.modules)) {
      if (digests[platform]?.[expected.digestKey]?.hash !== expected.release) issues.push(`${platform}_release_unverified`);
    }
    if (issues.length) return { ok: false, issues };
    for (const [platform, expected] of Object.entries(contract.modules)) {
      const actual = await client.getXFormDesktopModuleSha256({ modulePath: expected.path, releaseHash: expected.release });
      if (actual !== expected.sha256) issues.push(`${platform}_bundle_unverified`);
    }
    return { ok: issues.length === 0, issues };
  } catch {
    return { ok: false, issues: ["runtime_read_failed"] };
  }
}
