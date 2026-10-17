import {createHash} from 'node:crypto';
import {canonicalJson} from '../agent-review/digest.js';
import {REMOTE_OMISSION_KIND,REMOTE_OMISSION_FUNCTION,remoteOmissionPlan,validateRemoteOmissionDecisions} from '../dsl/omitted-remote-selector.js';
const rawHash=value=>'sha256:'+createHash('sha256').update(String(value)).digest('hex');
const identity=item=>({sourceRef:item.field.sourceRef,fieldId:item.field.id,...(item.tableId?{tableId:item.tableId}:{})});
const hasWord=(text,word)=>new RegExp('(^|[^A-Za-z0-9_$])'+word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^A-Za-z0-9_$]|$)').test(text);
export function applyRemoteOmissionPolicies(sourceDraft,baseDraft,decisions){
 const checked=validateRemoteOmissionDecisions(decisions);if(!checked.ok)throw Object.assign(new Error('Invalid explicit remote omission policy.'),{diagnostics:checked.diagnostics});
 const draft=structuredClone(baseDraft),audits=[],changedActionIds=[],plans=decisions.map(decision=>({decision,plan:remoteOmissionPlan(draft.form,decision)}));
 const sourceUnits=sourceDraft.scripts?.sources||[];
 const retiredRefs=new Set(plans.flatMap(({plan})=>sourceUnits.filter(source=>rawHash(source.javascript)===plan.fact.script.javascriptSha256).map(source=>source.sourceRef||source.id)));
 for(const {decision,plan}of plans){
  const sources=sourceUnits.filter(source=>rawHash(source.javascript)===plan.fact.script.javascriptSha256);
  const refs=sources.length?sources.map(source=>source.sourceRef||source.id):[decision.sourceRef],names=plan.fact.script.functionNames;
  const sourceScripts=sources.length?sources.map(source=>({sourceRef:source.sourceRef||source.id,javascriptSha256:rawHash(source.javascript)})):[{sourceRef:decision.sourceRef,javascriptSha256:plan.fact.script.javascriptSha256,carrier:"verified-field-runtime",length:plan.fact.script.javascriptLength}];
  if(plan.fact.script.foreignReferences!==false||!Number.isInteger(plan.fact.script.javascriptLength)||plan.fact.script.javascriptLength<=0)throw Error("The omitted runtime unit has an unproved external dependency.");
  if(!Array.isArray(names)||!names.length||sourceUnits.filter(source=>!retiredRefs.has(source.sourceRef||source.id)).some(source=>names.some(name=>hasWord(source.javascript,name))))throw Error('An unretired source unit depends on the omitted selector functions.');
  if(plan.fact.script.scaffolding?.includes('generated-index-replaceAll-polyfill')&&sourceUnits.filter(source=>!retiredRefs.has(source.sourceRef||source.id)).some(source=>/\.\s*replaceAll\s*\(/.test(source.javascript)))throw Error('An unretired source unit may depend on the omitted compatibility polyfill.');
  if(plan.companions.some(item=>sourceUnits.filter(source=>!retiredRefs.has(source.sourceRef||source.id)).some(source=>hasWord(source.javascript,item.field.id))||hasWord(JSON.stringify(draft.workflow||{}),item.field.id)||hasWord(JSON.stringify(draft.formRules||{}),item.field.id)))throw Error('An inactive selector companion has a retained business dependency.');
  const inactive=[...plan.inactiveOutputs.map(item=>item.field.id),...plan.missingOutputs];if(inactive.some(id=>sourceUnits.filter(source=>!retiredRefs.has(source.sourceRef||source.id)).some(source=>hasWord(source.javascript,id))||hasWord(JSON.stringify(draft.workflow||{}),id)||hasWord(JSON.stringify(draft.formRules||{}),id)))throw Error('An inactive hidden or missing remote output has a retained business dependency.');
  const previous=(draft.scripts?.actions||[]).filter(action=>action.sourceRefs?.some(ref=>refs.includes(ref)));
  if(sources.length&&!previous.length||previous.some(action=>action.sourceRefs.some(ref=>!refs.includes(ref))))throw Error('An omitted selector action shares unrelated authored behavior.');
  if(previous.some(action=>action.semanticHints?.approvedNativeLookup))throw Error('A selector cannot be both migrated and omitted.');
  for(const [items,role]of [[plan.manual,'manual'],[plan.companions,'inactive-companion']])for(const item of items){
   item.field.sourceProps={...item.field.sourceProps,approvedRemoteOmissions:[...(item.field.sourceProps?.approvedRemoteOmissions||[]),{decisionId:decision.id,selectorSourceRef:decision.sourceRef,role}]};
   item.field.props={...item.field.props,readOnly:role!=='manual'};
   if(role==='inactive-companion'){item.field.dataOnly=true;item.field.props.required=false;}
  }
  const actionId='policy.omit_remote.'+rawHash(decision.sourceRef).slice(7,23);
  if(draft.scripts.actions.some(action=>action.id===actionId))throw Error('Remote omission action identity collides.');
  const action={id:actionId,name:'onLoad',event:'onLoad',scope:'global',function:REMOTE_OMISSION_FUNCTION,sourceRefs:refs,sourceActionKey:decision.sourceRef+'#omit-remote-lookup',translationStatus:'mapped',coverage:{status:'translated',nativeRules:[],residuals:[]},functionMappings:[{source:'Caller-excluded remote lookup and backfill',target:'Explicit no remote behavior',basis:'approved-remote-omission-pending-wrapper',reviewRequired:true}],semanticHints:{approvedRemoteOmission:{decisionId:decision.id,sourceRef:decision.sourceRef}}};
  draft.scripts.actions=draft.scripts.actions.filter(item=>!previous.includes(item));draft.scripts.actions.push(action);changedActionIds.push(actionId);
  audits.push({kind:REMOTE_OMISSION_KIND,decisionId:decision.id,sourceRef:decision.sourceRef,status:'intentionally-omitted',contractDigest:decision.contractDigest,omissionFactDigest:decision.omissionFactDigest,method:plan.contract.kind==='SQL'?'SQL':plan.contract.requestResource.method,actionId,sourceScripts,functionNames:names,manualFields:plan.manual.map(identity),inactiveCompanions:plan.companions.map(identity),inactiveHiddenOutputs:plan.inactiveOutputs.map(identity),missingGuardedOutputs:plan.missingOutputs,removedActionIds:previous.map(action=>action.id),capabilitiesOmitted:['remote query','remote selector prerequisites','automatic backfill','dual-value synchronization'],preserved:['field identities and types','visible field required checks','unrelated scripts and rules','workflow routes and permissions'],workflowBefore:rawHash(canonicalJson(draft.workflow||null)),upstreamCalls:0});
 }
 return {draft,audits,changedActionIds};
}
