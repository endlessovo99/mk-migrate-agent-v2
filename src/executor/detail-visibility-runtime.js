// The sync uses the form builder's native SDK and permission-state contract.
// Only these QAS bundles have been captured for this route.
export const DETAIL_VISIBILITY_RUNTIME = Object.freeze({
  origin: "https://oaqas.shanghai-electric.com",
  modules: Object.freeze({
    desktop: Object.freeze({
      digestKey: "@module:sys-xform/desktop/api/XFormRuntime",
      path: "sys-xform/desktop/api/XFormRuntime",
      release: "a3ec998c10af6bbce34dd6caffe4a203",
      sha256: "a3ee70fad7030bd66884aa39a2e28e59d3472671b0d633acd0fb05d4d48c91ba"
    }),
    mobile: Object.freeze({
      digestKey: "@module:sys-xform/mobile/api/XFormRuntime",
      path: "sys-xform/mobile/api/XFormRuntime",
      release: "4d998c2e4de3862a836c2339c5d583dd",
      sha256: "73e546b0d9ce8a442e27ea4f3a30622bf2c036fcb106ffd45d81a91b728551e2"
    })
  })
});

export async function inspectDetailVisibilityRuntime(client, baseUrl) {
  if (baseUrl !== DETAIL_VISIBILITY_RUNTIME.origin) return { ok: false, issues: ["origin_unverified"] };
  if (typeof client?.getXFormDesktopDigest !== "function" ||
      typeof client?.getXFormMobileDigest !== "function" ||
      typeof client?.getXFormDesktopModuleSha256 !== "function") {
    return { ok: false, issues: ["runtime_read_api_missing"] };
  }
  try {
    const digests = { desktop: await client.getXFormDesktopDigest(), mobile: await client.getXFormMobileDigest() };
    const issues = [];
    for (const [platform, expected] of Object.entries(DETAIL_VISIBILITY_RUNTIME.modules)) {
      if (digests[platform]?.[expected.digestKey]?.hash !== expected.release) issues.push(`${platform}_release_unverified`);
    }
    if (issues.length) return { ok: false, issues };
    for (const [platform, expected] of Object.entries(DETAIL_VISIBILITY_RUNTIME.modules)) {
      const actual = await client.getXFormDesktopModuleSha256({ modulePath: expected.path, releaseHash: expected.release });
      if (actual !== expected.sha256) issues.push(`${platform}_bundle_unverified`);
    }
    return { ok: issues.length === 0, issues };
  } catch {
    return { ok: false, issues: ["runtime_read_failed"] };
  }
}
