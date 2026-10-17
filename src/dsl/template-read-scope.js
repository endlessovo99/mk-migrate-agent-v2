import {createHash} from 'node:crypto';
import {canonicalJson as stableStringify} from '../agent-review/digest.js';

const PERSON='com.landray.kmss.sys.organization.model.SysOrgPerson';
const DIGEST=/^sha256:[a-f0-9]{64}$/;
export const TEMPLATE_READ_SCOPE_VERSION=1;
const hash=value=>'sha256:'+createHash('sha256').update(typeof value==='string'?value:stableStringify(value)).digest('hex');
const same=(a,b)=>stableStringify(a)===stableStringify(b);
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&same(Object.keys(value).sort(),[...expected].sort());
export function hasEveryoneSourceMember(auth){return ['readers','allReaders','editors','allEditors','temporaryReaders','temporaryEditors'].some(key=>Array.isArray(auth?.[key])&&auth[key].some(member=>member?.sourceLoginName==='everyone'));}
export function authorizationWithoutReadScope(auth){const {readScope:_scope,...original}=auth||{};return original;}

/** Source-neutral effective access fact. It selects no NewOA identity. */
export function bindEveryoneSourceScope(auth,{templateId,formTemplateId,processTemplateId,xml,readersPresence}={}){
 if(!hasEveryoneSourceMember(auth))return auth;
 if(typeof xml!=='string'||!xml.trim())throw Object.assign(new Error('Everyone authorization requires the original XML bytes.'),{code:'source.template.everyone_scope_unproven'});
 const evidence={templateId,formTemplateId,processTemplateId,xmlSha256:hash(xml||''),readersPresence,authorizationSha256:hash(authorizationWithoutReadScope(auth))};
 const body={version:TEMPLATE_READ_SCOPE_VERSION,mode:'everyone',sourceRef:'source.template.authorization.authAllReaders.0',evidence};
 const result={...auth,readScope:{...body,digest:hash(body)}};
 const issues=templateReadScopeIssues(result);
 if(issues.length)throw Object.assign(new Error('Source everyone authorization is incomplete or ambiguous.'),{code:'source.template.everyone_scope_unproven',issues});
 return result;
}

/** Public DSL keeps exact source evidence; resolved workcopies use a separate runtime binding. */
export function templateReadScopeIssues(auth){
 if(!auth?.readScope){
  if(hasEveryoneSourceMember(auth))return ['everyone_source_scope_required'];
  return Array.isArray(auth?.readers)&&auth.readers.length===0&&Array.isArray(auth?.allReaders)&&auth.allReaders.length===0?['empty_read_scope_unproven']:[];
 }
 const scope=auth.readScope,e=scope.evidence,member=auth.allReaders?.[0],issues=[];
 if(!keys(scope,['version','mode','sourceRef','evidence','digest'])||scope.version!==1||scope.mode!=='everyone'||scope.sourceRef!=='source.template.authorization.authAllReaders.0')issues.push('read_scope_shape_invalid');
 if(!keys(e,['templateId','formTemplateId','processTemplateId','xmlSha256','readersPresence','authorizationSha256'])||typeof e.templateId!=='string'||!e.templateId||e.templateId!==e.formTemplateId||e.templateId!==e.processTemplateId||!DIGEST.test(e.xmlSha256||'')||!['absent','empty'].includes(e.readersPresence))issues.push('read_scope_source_binding_invalid');
 if(auth.readerFlag!==true||auth.readers?.length!==0||auth.temporaryReaders?.length!==0||auth.allReaders?.length!==1||member?.sourceLoginName!=='everyone'||member.sourceOrgType!==8||member.sourceOrgClass!==PERSON||typeof member.sourceId!=='string'||!member.sourceId.trim()||member.id||member.sourceParentName||member.sourceRef!==scope.sourceRef)issues.push('read_scope_everyone_source_invalid');
 for(const key of ['editors','allEditors','temporaryEditors'])if(Array.isArray(auth[key])&&auth[key].some(m=>m?.sourceLoginName==='everyone'||(member?.sourceId&&m?.sourceId===member.sourceId)))issues.push('read_scope_mixed_builtin_unsupported');
 const {digest,...body}=scope;
 if(!DIGEST.test(digest||'')||digest!==hash(body)||e?.authorizationSha256!==hash(authorizationWithoutReadScope(auth)))issues.push('read_scope_digest_mismatch');
 return [...new Set(issues)];
}

export function sourceReadScopeBindingIssues(sourceDraft){
 const auth=sourceDraft?.template?.authorization,issues=templateReadScopeIssues(auth);
 if(!auth?.readScope||issues.length)return issues;
 const e=auth.readScope.evidence,s=sourceDraft.source;
 if(s?.kmReviewTemplate?.fdId!==e.templateId||s.kmReviewTemplate.xmlSha256!==e.xmlSha256||s?.sysFormTemplate?.fdModelId!==e.formTemplateId||s?.lbpmProcessDefinition?.templateId!==e.processTemplateId)issues.push('read_scope_current_source_mismatch');
 return [...new Set(issues)];
}
