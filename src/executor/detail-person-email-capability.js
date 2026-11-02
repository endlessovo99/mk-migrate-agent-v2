import {DETAIL_PERSON_EMAIL_CAPABILITY as contract} from '../dsl/detail-person-email-capability.js';
/** Verify the target's observed platform artifacts before writing a script that calls person info. */
export async function inspectDetailPersonEmailRuntime(client, baseUrl) {
  if (baseUrl !== contract.origin) return {ok:false,issues:['origin_unverified']};
  if (!['getXFormDesktopDigest','getXFormMobileDigest','getSysOrgDesktopDigest','getXFormDesktopModuleSha256'].every(k=>typeof client?.[k]==='function')) return {ok:false,issues:['native_asset_read_api_missing']};
  try {
    const modules=contract.modules, digests=await Promise.all([client.getXFormDesktopDigest(),client.getXFormMobileDigest(),client.getSysOrgDesktopDigest()]);
    const parts=[modules.desktop,modules.mobile,modules.person],issues=[];
    parts.forEach((m,i)=>{if(digests[i]?.[m.digestKey]?.hash!==m.release)issues.push(`release_unverified:${m.digestKey}`)});
    if (issues.length) return {ok:false,issues};
    const hashes=await Promise.all(parts.map(m=>client.getXFormDesktopModuleSha256({modulePath:m.path,releaseHash:m.release})));
    parts.forEach((m,i)=>{if(hashes[i]!==m.sha256)issues.push(`asset_unverified:${m.path}`)});
    return {ok:issues.length===0,issues};
  } catch {return {ok:false,issues:['native_asset_read_failed']};}
}
