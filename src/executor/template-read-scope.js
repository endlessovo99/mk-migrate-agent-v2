import {createHash} from 'node:crypto';
import {templateReadScopeIssues,hasEveryoneSourceMember} from '../dsl/template-read-scope.js';
import {stableStringify} from './persistence/normalize.js';

// Bound to the retained native permission form/config contract, not a process.
export const NATIVE_TEMPLATE_READER_CAPABILITY=Object.freeze({
 id:'native-template-public-readers-v1',
 digestKey:'@module:km-review/desktop/pages/kmReviewTemplate/edit',
 modulePath:'km-review/desktop/pages/kmReviewTemplate/edit',
 release:'645549c841832b4eb994d51b316b9c25',
 sha256:'5708735c67eee0378ad73bccc5182ab8b17ffd36ce1166a0dbeb5afdd95d77d6'
});
const hash=value=>createHash('sha256').update(stableStringify(value)).digest('hex');
const fail=reason=>{throw Object.assign(new Error('Native template reader scope could not be verified: '+reason),{code:'template.read_scope.'+reason});};
const text=value=>typeof value==='string'&&value.length>0&&value.trim()===value;

export async function resolveTemplateReadScope(dsl,{client,targetBaseUrl,templateAuthorizationOverrides}={}){
 const auth=dsl?.template?.authorization;
 if(!auth?.readScope&&!hasEveryoneSourceMember(auth))return undefined;
 if(templateReadScopeIssues(auth).length)fail('source_unproven');
 if(client?.baseUrl!==undefined&&client.baseUrl!==targetBaseUrl)fail('origin_mismatch');
 if(!['getKmReviewDesktopDigest','getKmReviewTemplateEditSha256','getTemplateReaderConfiguration','getElementInfo'].every(key=>typeof client?.[key]==='function'))fail('native_contract_unavailable');
 const digest=await client.getKmReviewDesktopDigest(),cap=NATIVE_TEMPLATE_READER_CAPABILITY;
 if(digest?.[cap.digestKey]?.hash!==cap.release)fail('module_version_unrecognized');
 if(await client.getKmReviewTemplateEditSha256({releaseHash:cap.release})!==cap.sha256)fail('module_content_unrecognized');
 const config=await client.getTemplateReaderConfiguration();
 if(!config||typeof config!=='object'||Array.isArray(config)||(Object.hasOwn(config,'business')&&(!config.business||typeof config.business!=='object'||Array.isArray(config.business))))fail('configuration_unrecognized');
 const value=config.business?.templateEmptyNotUse;
 if(value==='true')fail('empty_deny_unsupported');
 if(value!==undefined&&value!=='false')fail('configuration_unrecognized');
 const source=auth.allReaders[0];
 if(templateAuthorizationOverrides!==undefined&&!Array.isArray(templateAuthorizationOverrides))fail('builtin_mapping_invalid');
 const maps=(templateAuthorizationOverrides||[]).filter(m=>m?.sourceId===source.sourceId);
 if(maps.length>1)fail('builtin_mapping_ambiguous');
 let targetId=maps[0]?.targetFdId;
 if(targetId!==undefined&&!text(targetId))fail('builtin_mapping_invalid');
 if(!targetId){
  if(typeof client.searchOrg!=='function')fail('builtin_mapping_required');
  const candidates=await client.searchOrg('everyone',8);
  if(!Array.isArray(candidates))fail('builtin_lookup_invalid');
  const matches=candidates.filter(isNativeEveryone);
  if(matches.length!==1)fail(matches.length?'builtin_mapping_ambiguous':'builtin_mapping_required');
  targetId=matches[0].fdId;
 }
 const elements=await client.getElementInfo([targetId],{builtinEvidence:true});
 if(!Array.isArray(elements)||elements.length!==1||elements[0].fdId!==targetId||!isNativeEveryone(elements[0]))fail('builtin_identity_mismatch');
 const entity=elements[0],binding={version:1,status:'verified',capabilityId:cap.id,baseUrl:new URL(targetBaseUrl).origin,
  sourceScopeDigest:auth.readScope.digest,sourceId:source.sourceId,moduleRelease:cap.release,moduleSha256:cap.sha256,
  emptyReadBehavior:'everyone',configuration:{present:value!==undefined,value:value??null},
  everyone:{id:entity.fdId,name:entity.fdName,targetOrgType:8,loginName:'everyone',available:true,business:false}};
 return {...binding,seal:hash(binding)};
}

export function isNativeEveryone(member){
 if(!member||!text(member.fdId)||!text(member.fdName)||Number(member.fdOrgType)!==8||member.fdIsAvailable!==true||member.fdIsBusiness!==false||member.fdAccount?.fdLoginName!=='everyone')return false;
 return [member.fdLoginName,member.fdNo].filter(v=>v!==undefined&&v!==null&&v!=='').every(v=>v==='everyone');
}

export function verifiedTemplateReadBinding(dsl){
 const scope=dsl?.template?.authorization?.readScope,b=dsl?.runtime?.nativeTemplateReadScope,cap=NATIVE_TEMPLATE_READER_CAPABILITY;
 if(!scope||scope.mode!=='everyone'||!b)return false;
 const {seal,...body}=b;
 return b.version===1&&b.status==='verified'&&b.capabilityId===cap.id&&b.sourceScopeDigest===scope.digest&&b.sourceId===dsl.template.authorization.allReaders?.[0]?.sourceId&&
  b.moduleRelease===cap.release&&b.moduleSha256===cap.sha256&&b.emptyReadBehavior==='everyone'&&
  ((b.configuration?.present===false&&b.configuration.value===null)||(b.configuration?.present===true&&b.configuration.value==='false'))&&
  b.everyone?.targetOrgType===8&&b.everyone.loginName==='everyone'&&b.everyone.available===true&&b.everyone.business===false&&text(b.everyone.id)&&text(b.everyone.name)&&seal===hash(body);
}

export async function verifyTemplateReadRuntime(dsl,{client,targetBaseUrl}={}){
 const binding=dsl?.runtime?.nativeTemplateReadScope;
 if(!dsl?.template?.authorization?.readScope)return {ok:true};
 try{
  if(!verifiedTemplateReadBinding(dsl))fail('runtime_binding_invalid');
  // Reconstruct only the original source authorization evidence, not a new identity choice.
  // Names may have been resolved. Use the bound, checked original DSL retained by the resolver.
  const original=dsl.runtime.templateReadScopeSource;
  if(!original)fail('runtime_source_invalid');
  const refreshed=await resolveTemplateReadScope({template:{authorization:original}},{client,targetBaseUrl,templateAuthorizationOverrides:[{sourceId:binding.sourceId,targetFdId:binding.everyone.id}]});
  if(refreshed.seal!==binding.seal)fail('runtime_drift');
  return {ok:true,capabilityId:binding.capabilityId};
 }catch(error){return {ok:false,diagnostics:[{level:'error',code:error.code||'template.read_scope.runtime_drift',message:'The native permission configuration or builtin identity changed before transfer recording.',path:'/readback/workflow/templateAuthorization'}]};}
}
