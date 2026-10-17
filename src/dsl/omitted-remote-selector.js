import {remoteOmissionContractEligible} from "./remote-omission-contract.js";
import {canonicalJson,sha256Digest} from '../agent-review/digest.js';
import {hasVerifiedDeterministicScriptBranchProof} from './deterministic-script-translations.js';
export const REMOTE_OMISSION_KIND='omit-remote-selector';
export const REMOTE_OMISSION_FUNCTION='function onLoad() {}';
const hash=value=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const omissionFields=form=>(form?.fields||[]).flatMap(field=>field.type==='detailTable'?(field.columns||[]).map(column=>({field:column,tableId:field.id})):[{field}]);
export function validateRemoteOmissionDecisions(decisions){
 const diagnostics=[],ids=new Set(),refs=new Set();
 if(!Array.isArray(decisions))return {ok:false,diagnostics:[{level:'error',code:'migration.policy.remote_omission.invalid',message:'Explicit omission decisions must be an array.'}]};
 for(const d of decisions){
  if(!exact(d,['id','kind','sourceRef','contractDigest','omissionFactDigest','mode'])||typeof d.id!=='string'||!d.id||d.kind!==REMOTE_OMISSION_KIND||typeof d.sourceRef!=='string'||!d.sourceRef||!hash(d.contractDigest)||!hash(d.omissionFactDigest)||d.mode!=='manual-values'||ids.has(d.id)||refs.has(d.sourceRef))diagnostics.push({level:'error',code:'migration.policy.remote_omission.invalid',message:'Remote omission requires an exact unique source binding, source digests and explicit manual-values mode.'});
  ids.add(d?.id);refs.add(d?.sourceRef);
 }
 return {ok:diagnostics.length===0,diagnostics};
}
export function remoteOmissionPlan(form,decision){
 const all=omissionFields(form),matches=all.filter(item=>item.field.sourceRef===decision.sourceRef);
 if(matches.length!==1)throw Error('The omitted selector source reference is not unique.');
 const primary=matches[0],contract=primary.field.sourceProps?.remoteSelectorSourceContract,fact=primary.field.sourceProps?.remoteSelectorOmissionSourceFact;
 if(primary.field.type!=='text'||primary.field.componentId!=='xform-input'||primary.field.sourceProps?.metadataAttributes?.type!=='String'||primary.field.dataOnly===true)throw Error('The manual selector value must retain its existing visible String input.');
 if(!['REST','SQL'].includes(contract?.kind)||!remoteOmissionContractEligible(contract)||sha256Digest(contract)!==decision.contractDigest||fact?.status!=='verified'||fact.digest!==decision.omissionFactDigest||sha256Digest(Object.fromEntries(Object.entries(fact).filter(([key])=>key!=='digest')))!==fact.digest||fact.fieldId!==primary.field.id||fact.tableId!==primary.tableId||contract.fieldId!==primary.field.id||contract.tableId!==primary.tableId||fact.script?.grammar!==(contract.kind==='SQL'?'generated-sql-selector-omission-closed-v1':'generated-rest-selector-omission-closed-v1')||fact.script.foreignReferences!==false||fact.script.soleSelector!==true||!hash(fact.script.javascriptSha256)||!Number.isInteger(fact.script.javascriptLength)||fact.script.javascriptLength<=0||fact.script.scope?.kind!=='remote-selector-unit'||fact.script.scope.fieldId!==primary.field.id||fact.script.scope.tableId!==primary.tableId||fact.script.scope.method!==(contract.kind==='SQL'?'SQL':contract.requestResource?.method)||canonicalJson(fact.sourceHashes)!==canonicalJson(contract.sourceOrigin))throw Error('Remote omission source proof is incomplete or stale.');
 const resolve=identity=>{const parts=identity.split('.'),tableId=parts.length===2?parts[0]:undefined,id=parts.at(-1);const found=all.filter(item=>item.tableId===tableId&&item.field.id===id);if(found.length===0&&fact.missingOutputFields?.includes(identity))return undefined;if(parts.length>2||found.length!==1||tableId&&tableId!==primary.tableId||!['text','longText','number','date','dateTime'].includes(found[0].field.type)||found[0].field.dataOnly===true)throw Error('Manual remote values require existing visible primitive fields.');return found[0];};
 const outputs=contract.outputMappings.filter(mapping=>mapping.enabled!==false).map(mapping=>{if(mapping.private||!mapping.targetField)throw Error('Remote output identity is unproved.');return resolve(mapping.targetField);}).filter(Boolean);
 const inactiveOutputs=outputs.filter(item=>item.field.componentId==='xform-hidden');if(inactiveOutputs.some(item=>item.field.props?.required===true))throw Error('A hidden required output cannot be omitted.');
 const manual=[primary,...outputs.filter(item=>!inactiveOutputs.includes(item))];
 const unique=[...new Map(manual.map(item=>[(item.tableId||'')+'.'+item.field.id,item])).values()];
 const companion=all.filter(item=>item.tableId===primary.tableId&&item.field.id===fact.displayFieldId);
 if(companion.length>1||companion.some(item=>item.field.sourceProps?.metadataAttributes?.type!=='String'||unique.some(manual=>manual.field===item.field)))throw Error('The inactive selector companion must be uniquely source-backed.');
 return {primary,contract,fact,manual:unique,companions:companion,inactiveOutputs,missingOutputs:fact.missingOutputFields||[]};
}
const marker=(field,id,role)=>Array.isArray(field.sourceProps?.approvedRemoteOmissions)&&field.sourceProps.approvedRemoteOmissions.some(value=>value.decisionId===id&&value.role===role);
export function omittedSelectorBinding(dsl,field){
 try{
  const decisions=(dsl?.migrationPolicies?.decisions||[]).filter(d=>d.kind===REMOTE_OMISSION_KIND&&d.sourceRef===field.sourceRef);
  if(decisions.length!==1||!validateRemoteOmissionDecisions(decisions).ok)return;
  const decision=decisions[0],plan=remoteOmissionPlan(dsl.form,decision),audits=(dsl.migrationPolicyAudit?.audits||[]).filter(a=>a.kind===REMOTE_OMISSION_KIND&&a.decisionId===decision.id&&a.sourceRef===decision.sourceRef);
  if(audits.length!==1)return;const audit=audits[0],actions=(dsl.scripts?.actions||[]).filter(a=>a.id===audit.actionId);
  if(actions.length!==1)return;const action=actions[0];
  if(audit.workflowBefore!==sha256Digest(dsl.workflow||null))return;
  if(action.function!==REMOTE_OMISSION_FUNCTION||action.event!=='onLoad'||action.scope!=='global'||action.tableId!==undefined||action.controlId!==undefined||!hasVerifiedDeterministicScriptBranchProof(action)||audit.contractDigest!==decision.contractDigest||audit.omissionFactDigest!==decision.omissionFactDigest||audit.status!=='intentionally-omitted'||canonicalJson(action.sourceRefs)!==canonicalJson(audit.sourceScripts.map(item=>item.sourceRef)))return;
  if(plan.manual.some(item=>item.field.props?.readOnly!==false||!marker(item.field,decision.id,'manual'))||plan.companions.some(item=>item.field.dataOnly!==true||item.field.props?.required!==false||!marker(item.field,decision.id,'inactive-companion')))return;
  const identities=items=>items.map(item=>({sourceRef:item.field.sourceRef,fieldId:item.field.id,...(item.tableId?{tableId:item.tableId}:{})}));
  if(audit.method!==(plan.contract.kind==='SQL'?'SQL':plan.contract.requestResource.method)||canonicalJson(audit.manualFields)!==canonicalJson(identities(plan.manual))||canonicalJson(audit.inactiveCompanions)!==canonicalJson(identities(plan.companions))||canonicalJson(audit.inactiveHiddenOutputs||[])!==canonicalJson(identities(plan.inactiveOutputs))||canonicalJson(audit.missingGuardedOutputs||[])!==canonicalJson(plan.missingOutputs))return;
  return {decision,audit,action,plan};
 }catch{return;}
}
export function isOmittedRemoteManualField(dsl,field){
 return (dsl?.migrationPolicies?.decisions||[]).filter(d=>d.kind===REMOTE_OMISSION_KIND).some(d=>{const primary=omissionFields(dsl.form).find(item=>item.field.sourceRef===d.sourceRef)?.field;const binding=primary&&omittedSelectorBinding(dsl,primary);return binding?.plan.manual.some(item=>item.field.sourceRef===field?.sourceRef);});
}
export function remoteOmissionDslDiagnostics(dsl){
 const errors=[],decisions=(dsl?.migrationPolicies?.decisions||[]).filter(d=>d.kind===REMOTE_OMISSION_KIND);
 const fail=()=>errors.push({level:'error',code:'dsl.remote_omission_binding_invalid',message:'Omitted remote features require their exact approved source unit, manual fields and fixed no-op binding.',path:'/migrationPolicyAudit'});
 for(const d of decisions){const fields=omissionFields(dsl.form).filter(item=>item.field.sourceRef===d.sourceRef);if(fields.length!==1||!omittedSelectorBinding(dsl,fields[0].field))fail();}
 for(const action of dsl?.scripts?.actions||[])if(action.semanticHints?.approvedRemoteOmission&&!decisions.some(d=>d.id===action.semanticHints.approvedRemoteOmission.decisionId))fail();
 return errors;
}
