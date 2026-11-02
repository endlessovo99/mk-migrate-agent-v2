import {inspectDetailVisibilityRuntime} from './detail-visibility-runtime.js';
import {inspectRegistry} from './detail-cell-presentation-capability.js';

// QAS element versions observed in the native button/dispatcher investigation.
export const DYNAMIC_LINK_RUNTIME = Object.freeze({
  origin: 'https://oaqas.shanghai-electric.com',
  releases: Object.freeze({
    '@elem/xform-base': 'FhCQn3KCy9',
    '@elem/xform-button': 'PQTu74yATD',
    '@elem/xform-m-button': 'RvgZP9lwSS'
  }),
  assetReleases: Object.freeze({
    'sys/artifact/elements/xform-base/index.js': 'FhCQn3KCy9',
    'sys/artifact/elements/xform-button/index.js': 'PQTu74yATD',
    'sys/artifact/elements/xform-m-button/index.js': 'RvgZP9lwSS'
  }),
  assets: Object.freeze({
    'sys/artifact/elements/xform-base/index.js': 'b4f4b7e2ca8a11f79542321d001853890a44c4676edbfe661466f6ebc5678d4a',
    'sys/artifact/elements/xform-button/index.js': 'ee5a579c0e269f5417debcc08f8bdc5ff59bb28b896f275462bddd2ff61b2277',
    'sys/artifact/elements/xform-m-button/index.js': '6f7921809365b4b13d76c18b102ca172ae6608a22f53b0ffdfdfb596e686339f'
  })
});

export async function inspectDynamicLinkRuntime(client, baseUrl) {
  if (baseUrl !== DYNAMIC_LINK_RUNTIME.origin) return {ok:false, issues:['origin_unverified']};
  if (typeof client?.getDetailCellElementRegistry !== 'function' || typeof client?.getDynamicLinkAssetSha256 !== 'function') return {ok:false, issues:['native_asset_read_api_missing']};
  try {
    const sdk = await inspectDetailVisibilityRuntime(client, baseUrl);
    if (!sdk.ok) return {ok:false, issues:sdk.issues.map(issue=>'sdk_'+issue)};
    const releases = inspectRegistry(await client.getDetailCellElementRegistry(), DYNAMIC_LINK_RUNTIME.releases);
    const issues = Object.entries(DYNAMIC_LINK_RUNTIME.releases).filter(([key,value])=>releases.get(key)!==value).map(([key])=>'release_unverified:'+key);
    if (issues.length) return {ok:false, issues};
    for (const [path, expected] of Object.entries(DYNAMIC_LINK_RUNTIME.assets)) {
      if (await client.getDynamicLinkAssetSha256({assetPath:path}) !== expected) issues.push('asset_unverified:'+path);
    }
    return {ok:issues.length===0, issues};
  } catch { return {ok:false, issues:['native_asset_read_failed']}; }
}
