import {sha256Digest} from '../agent-review/digest.js';
const clone=v=>JSON.parse(JSON.stringify(v));
const same=(a,b)=>sha256Digest(a)===sha256Digest(b);
const hashPattern=/^(?:sha256:)?[a-f0-9]{64}$/;
const sourceHashes=h=>h&&['fdDesignerHtml','fdDisplayJsp','fdMetadataXml'].every(k=>hashPattern.test(h[k]||''));
const factNames=['sharedJsonStateSourceDomain','approvedRuntimePolicies','sourceFormRadioOrdinalDomain'];

/** Read-only bridge for additive parser proofs. Raw source/business values never normalize. */
export function compareTemplateReaderSourceEvolution(current,historical){
 try{
  const a=clone(current),b=clone(historical),additions=[];
  const scope=a.template.authorization?.readScope,oldScope=b.template.authorization?.readScope;
  if(oldScope&&!same(scope,oldScope))return {ok:false,additions};
  delete a.template.authorization?.readScope;delete b.template.authorization?.readScope;
  const xml=a.source.kmReviewTemplate?.xmlSha256,oldXml=b.source.kmReviewTemplate?.xmlSha256;
  if(oldXml&&xml!==oldXml)return {ok:false,additions};
  if(a.source.kmReviewTemplate)delete a.source.kmReviewTemplate.xmlSha256;if(b.source.kmReviewTemplate)delete b.source.kmReviewTemplate.xmlSha256;
  for(const source of [a,b])if(source.migrationPolicies)delete source.migrationPolicies.sourceDraftSha256;
  for(const collection of ['controls','dataFields'])for(const [i,field] of (a.form?.[collection]||[]).entries()){
   const old=b.form?.[collection]?.[i],fact=field.sourceProps?.mainStringValueBindingFact;
   if(fact&&!Object.hasOwn(old?.sourceProps||{},'mainStringValueBindingFact')){
    if(old?.id!==field.id||fact.version!==1||fact.fieldId!==field.id||!sourceHashes(fact.sourceHashes))return {ok:false,additions};
    additions.push({path:`/form/${collection}/${i}/sourceProps/mainStringValueBindingFact`,digest:sha256Digest(fact)});delete field.sourceProps.mainStringValueBindingFact;
   }
  }
  for(const [i,script] of (a.scripts?.sources||[]).entries())for(const name of factNames){
   const old=b.scripts?.sources?.[i],fact=script.semanticFacts?.[name];
   if(fact&&!Object.hasOwn(old?.semanticFacts||{},name)){
    if(old?.sourceRef!==script.sourceRef||fact.version!==1)return {ok:false,additions};
    if(name==='sharedJsonStateSourceDomain'&&(fact.contract!=='current-display-script-order-and-gates'||!['displaySha256','designerSha256','metadataSha256'].every(k=>hashPattern.test(fact[k]||''))||!Array.isArray(fact.scripts)))return {ok:false,additions};
    if(name==='approvedRuntimePolicies'&&(!sourceHashes(fact.sourceHashes)||!hashPattern.test(fact.digest||'')||!Array.isArray(fact.scripts)||!Array.isArray(fact.templateRows)))return {ok:false,additions};
    if(name==='sourceFormRadioOrdinalDomain'&&(fact.domain!=='exported-form-radio-groups'||fact.status!=='verified'||!sourceHashes(fact.sourceHashes)||!Array.isArray(fact.groups)))return {ok:false,additions};
    additions.push({path:`/scripts/sources/${i}/semanticFacts/${name}`,digest:sha256Digest(fact)});delete script.semanticFacts[name];
   }
  }
  return {ok:same(a,b),additions};
 }catch{return {ok:false,additions:[]};}
}
