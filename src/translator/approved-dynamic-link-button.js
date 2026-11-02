import {createHash} from 'node:crypto';
import {canonicalJson} from '../agent-review/digest.js';
import {DYNAMIC_LINK_BUTTON_KIND,nativeDynamicLinkClick,nativeDynamicLinkVisibility} from '../dsl/native-dynamic-link-button.js';
import {hasVerifiedDeterministicScriptBranchProof} from '../dsl/deterministic-script-translations.js';
import {inspectTruthyUrlOnlyDynamicHyperlink} from './dynamic-hyperlink.js';
import {validDynamicLinkAnchorWitness} from './dynamic-link-anchor-witness.js';
import {stableSourceGlobals} from './source-dynamic-link-globals.js';
const sha=value=>'sha256:'+createHash('sha256').update(String(value)).digest('hex');
const word=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,24}$/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
const text=value=>typeof value==='string'&&value.length>0&&value.length<500&&value.trim()===value&&!/[\r\n]/.test(value);
const keys=['kind','sourceRef','sourceJavascriptSha256','actionId','fieldId','sourceUrlFieldId','sourceReadPolicy'];
export function validateDynamicLinkButtonDecisions(decisions){const diagnostics=[];if(!Array.isArray(decisions)||!decisions.length)diagnostics.push({level:'error',code:'policy.dynamic_link_invalid',message:'A source-bound decision is required.'});else for(const d of decisions)if(!d||Object.keys(d).length!==keys.length||!keys.every(k=>Object.hasOwn(d,k))||d.kind!==DYNAMIC_LINK_BUTTON_KIND||d.sourceReadPolicy!=='native-current-value'||!text(d.sourceRef)||!text(d.actionId)||!/^sha256:[a-f0-9]{64}$/.test(d.sourceJavascriptSha256||'')||!word(d.fieldId)||!word(d.sourceUrlFieldId)||d.fieldId===d.sourceUrlFieldId)diagnostics.push({level:'error',code:'policy.dynamic_link_invalid',message:'Invalid exact source-bound dynamic link decision.'});return {ok:diagnostics.length===0,diagnostics};}
export function applyDynamicLinkButtonPolicies(source,draft,decisions){
 if(!validateDynamicLinkButtonDecisions(decisions).ok)throw Error('Invalid dynamic link button decision.');
 if(source.migrationPolicies?.scope?.baseUrl!=='https://oaqas.shanghai-electric.com')throw Error('Dynamic link button is scoped to the verified QAS origin.');
 const result=structuredClone(draft),audits=[],changedActionIds=[];
 for(const d of decisions){const sources=(source.scripts?.sources||[]).filter(s=>(s.sourceRef||s.id)===d.sourceRef),actions=(result.scripts?.actions||[]).filter(a=>a.id===d.actionId),fields=(result.form?.fields||[]).filter(f=>f.id===d.fieldId),urls=(result.form?.fields||[]).filter(f=>f.id===d.sourceUrlFieldId);
  if(sources.length!==1||sha(sources[0].javascript)!==d.sourceJavascriptSha256||actions.length!==1||fields.length!==1||urls.length!==1)throw Error('Dynamic link source, action or field identity mismatch.');
  const a=actions[0],f=fields[0],ev=f.sourceProps?.dynamicHyperlinkProjection,semantic=a.semanticHints?.dynamicHyperlink;
  if (!(source.scripts?.sources || []).every(entry => stableSourceGlobals(entry.javascript, (entry.sourceRef || entry.id) === d.sourceRef))) throw Error('A source-owned API declaration or reassignment invalidates the dynamic link.');
  const binding = urls[0].sourceProps?.mainStringValueBindingFact;
  if (binding?.fieldId !== d.sourceUrlFieldId || binding.metadata?.count !== 1 || binding.metadata?.type !== 'String' ||
      !['verified', 'unproven'].includes(binding.status)) throw Error('The URL requires one source-backed main String field.');
  if (urls[0].type !== 'text' || !['xform-hidden', 'xform-input'].includes(urls[0].componentId) ||
      urls[0].props?.multiple === true) throw Error('The URL requires a native scalar String text control.');
  if(canonicalJson(inspectTruthyUrlOnlyDynamicHyperlink(sources[0]))!==canonicalJson(ev))throw Error('The source must prove the exact truthy URL anchor branch.');
  const witness = sources[0].semanticFacts?.dynamicLinkAnchorWitness;
  if (!validDynamicLinkAnchorWitness(witness, sources[0], ev) ||
      witness.runtimeHtmlSha256 !== binding.sourceHashes?.fdDisplayJsp ||
      witness.designerHtmlSha256 !== binding.sourceHashes?.fdDesignerHtml ||
      canonicalJson(witness.runtimeScriptHashes) !== canonicalJson((source.scripts?.sources || []).map(item => sha(item.javascript).slice(7)))) {
    throw Error('A unique rendered source anchor witness bound to the URL source is required.');
  }
  if(a.event!=='onLoad'||a.scope!=='global'||a.sourceRefs?.length!==1||a.sourceRefs[0]!==d.sourceRef||!a.functionMappings?.some(m=>m.basis==='deterministic-dynamic-hyperlink')||!hasVerifiedDeterministicScriptBranchProof(a)||f.componentId!=='xform-hyperlinks'||f.sourceRef!==d.sourceRef||!f.generated||!ev||canonicalJson(ev)!==canonicalJson(semantic)||ev.sourceRef!==d.sourceRef||ev.generatedFieldId!==d.fieldId||ev.sourceUrlFieldId!==d.sourceUrlFieldId||ev.urlPolicy!=='http-or-https'||ev.conditionFieldId||ev.rowMarker||ev.destinationRowMarker||ev.unusedReadFieldId||urls[0].type==='detailTable')throw Error('Only the exact source-proven URL-only anchor may use a button.');
  const rows=(result.form.layout?.mkTree||[]).filter(row=>row.sourceRef===d.sourceRef&&row.children?.some(cell=>cell.refIds?.includes(d.fieldId)));if(rows.length!==1||rows[0].children.filter(cell=>cell.refIds?.includes(d.fieldId)).length!==1)throw Error('Dynamic link layout identity mismatch.');
  positionAtSourceRow(source.form?.layout, result.form.layout, rows[0], witness);
  const spec={buttonId:d.fieldId,sourceRef:d.sourceRef,target:ev.anchorTarget||'_self',urlFieldId:d.sourceUrlFieldId},clickId=d.actionId+'.native-button';if(result.scripts.actions.some(x=>x.id===clickId))throw Error('Dynamic link action identity collision.');
  f.type='button';f.componentId='xform-button';f.props={};f.reason='Source-bound dynamic link displayed as a native button.';
  f.sourceProps.dynamicHyperlinkProjection={...ev,urlPolicy:'source-as-is'};
  a.function=nativeDynamicLinkVisibility(spec);a.semanticHints={...a.semanticHints,dynamicHyperlink:{...semantic,urlPolicy:'source-as-is'},approvedNativeDynamicLink:spec};
  const click={...structuredClone(a),id:clickId,name:'onClick',event:'onClick',scope:'control',controlId:d.fieldId,function:nativeDynamicLinkClick(spec),semanticHints:{...a.semanticHints,approvedNativeDynamicLink:spec}};
  delete click.deterministicBranchProof;result.scripts.actions.push(click);audits.push({kind:d.kind,sourceRef:d.sourceRef,sourceJavascriptSha256:d.sourceJavascriptSha256,visibilityActionId:a.id,clickActionId:clickId,fieldId:d.fieldId,sourceUrlFieldId:d.sourceUrlFieldId,anchorWitnessSha256:witness.witnessSha256,sourceRow:witness.row,sourceColumn:witness.column,sourceBindingStatus:binding.status,sourceBindingReasons:binding.reasons || [],approvedDifference:'Source reads the first legacy DOM value; target uses the current native main String value.',workflowBefore:sha(canonicalJson(result.workflow??null))});changedActionIds.push(a.id,clickId);
  if (binding.status === 'unproven') {
    result.review ||= {};
    result.review.warnings ||= [];
    result.review.warnings.push({level:'warning',code:'migration.dynamic_link.current_value_unproven',path:'/form/fields',message:'The source first-DOM-value binding is not proven equivalent to the current native main String value.',details:{fieldId:d.sourceUrlFieldId,reasons:binding.reasons || []}});
  }
  result.review ||= {};
  result.review.warnings ||= [];
  result.review.warnings.push({level:'warning',code:'migration.dynamic_link.resolution_context_unproven',path:'/form/fields',message:'Relative addresses use the target page base; the legacy shell base and default target are not present in the source export.',details:{fieldId:d.sourceUrlFieldId}});
 }
 return {draft:result,audits,changedActionIds};
}

function positionAtSourceRow(sourceLayout, layout, generated, witness) {
  const rows = sourceLayout?.rows;
  if (!Array.isArray(rows) || !Array.isArray(layout?.mkTree) ||
      !Number.isInteger(sourceLayout.rootTable?.rowCount) || witness.row >= sourceLayout.rootTable.rowCount) {
    throw Error('Source anchor witness has no compatible root layout.');
  }
  const mapped = rows.map(row => ({row, index:Number(row.sourceRow)}));
  if (mapped.some(item => !Number.isInteger(item.index) || item.index < 0) ||
      mapped.some((item, index) => index > 0 && item.index <= mapped[index - 1].index) ||
      mapped.some(item => item.index === witness.row)) {
    throw Error('Source anchor witness row is not a uniquely empty source row.');
  }
  const sourceRefs = new Set(mapped.map(item => item.row.sourceRef));
  if (witness.gridColumns > 1) {
    generated.componentId = 'xform-multi-row-table-layout';
    generated.props = {rows:1, columns:witness.gridColumns};
    if (generated.children?.length !== 1) throw Error('The source anchor requires one generated control cell.');
    generated.children[0].row = 0;
    generated.children[0].column = witness.column;
    generated.children[0].colspan = witness.cellSpan;
  }
  generated.reason = 'Source-bound dynamic link displayed as a native button.';
  generated.children[0].reason = generated.reason;
  const next = mapped.find(item => item.index > witness.row);
  const tree = layout.mkTree.filter(item => item !== generated);
  let position;
  if (next) {
    const indexes = tree.flatMap((item, index) => item.sourceRef === next.row.sourceRef ? [index] : []);
    if (indexes.length !== 1) throw Error('The next source layout row is not uniquely mapped.');
    position = indexes[0];
  } else {
    const indexes = tree.flatMap((item, index) => sourceRefs.has(item.sourceRef) ? [index] : []);
    if (!indexes.length) throw Error('The source layout has no mapped row.');
    position = indexes.at(-1) + 1;
  }
  tree.splice(position, 0, generated);
  layout.mkTree = tree;
}
