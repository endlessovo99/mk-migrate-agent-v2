import { parse } from 'acorn';
import { createHash } from 'node:crypto';

export const LEGACY_DETAIL_ORG_HYDRATION_BASIS = 'deterministic-detail-org-hydration';
const personProperties = new Set(['fdId', 'fdName', 'fdLoginName']);
const elementProperties = new Set(['fdId', 'fdName']);
const compact = node => JSON.stringify(node, function(key, value) {
  if (['start', 'end', 'raw'].includes(key)) return undefined;
  if (key === 'key' && this.type === 'Property' && !this.computed) return {type: 'Literal', value: value.name ?? value.value};
  return value;
});
const parseProgram = text => { try { return parse(text, {ecmaVersion: 'latest'}); } catch { return undefined; } };
const member = (node, object, property) => node?.type === 'MemberExpression' && !node.computed &&
  node.object?.type === 'Identifier' && node.object.name === object && node.property?.name === property;
const string = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;

/** Lower only the complete fixed KMSSData value-change recipe, including its row and positional result projection. */
export function legacyDetailOrgHydrationCandidates(source = {}, form = {}, sourceScripts = {}) {
  const text = String(source.javascript || '');
  const program = parseProgram(text);
  if (program?.body.length !== 1) return [];
  const call = program.body[0]?.expression;
  if (program.body[0].type !== 'ExpressionStatement' || call?.type !== 'CallExpression' ||
      !member(call.callee, 'XFormOnValueChangeFuns', 'push') || call.arguments.length !== 1) return [];
  const callback = call.arguments[0];
  if (callback?.type !== 'FunctionExpression' || callback.async || callback.generator || callback.id ||
      compact(callback.params) !== compact(parseProgram('function f(value,domElement){}').body[0].params)) return [];
  const statements = callback.body.body;
  if (!statements?.length || compact(statements[0]) !== compact(parseProgram('var name=domElement[0].name;').body[0])) return [];
  const branches = statements.slice(1).map(branch => parseBranch(branch));
  if (!branches.length || branches.some(branch => !branch)) return [];
  const all = fields(form);
  if (all.some(({field}) => [field?.sourceProps?.designerId, field?.sourceProps?.metadataId, field?.sourceProps?.originalId, field?.sourceProps?.designerValues?.id]
    .some(alias => alias && alias !== field.id))) return [];
  if (all.some(({field}) => !field?.sourceRef) || new Set(all.map(({field}) => field.sourceRef)).size !== all.length) return [];
  const domain = sourceScripts.sources?.[0]?.semanticFacts?.staticDetailOrgEventDomain;
  const currentDomain = domain?.version === 1 && domain.scope === 'current-export-static-doclist-controls' &&
    domain.sourceJavascriptSha256 === createHash('sha256').update(text).digest('hex') && Array.isArray(domain.sourceControlIds) ? domain : undefined;
  const resolved = [];
  const absent = [];
  for (const branch of branches) {
    // A substring predicate is not an exact field binding when another source id has the same suffix.
    const triggerNames = [...new Set([...all.map(entry => entry.field.id), ...(currentDomain?.sourceControlIds || [])])]
      .filter(id => `${id}.id`.includes(`${branch.controlId}.id`));
    const triggers = all.filter(entry => triggerNames.includes(entry.field.id));
    if (!triggers.length) {
      // Closing an absent event branch requires the entire exported script set to be this fixed callback.
      const sources = Array.isArray(sourceScripts.sources) ? sourceScripts.sources : [];
      if (triggerNames.length || !currentDomain || sources.length !== 1 || String(sources[0].javascript || '') !== text) return [];
      absent.push({controlId: branch.controlId, start: branch.start, end: branch.end,
        reason: 'no exported control name can satisfy this predicate; the complete script set creates no controls'});
      continue;
    }
    if (triggers.length !== 1) return [];
    const trigger = triggers[0];
    if (!trigger.tableId || trigger.field.componentId !== 'xform-address' || trigger.field.props?.multi === true ||
        trigger.field.sourceProps?.designerValues?.multiSelect === 'true') return [];
    const targets = branch.outputs.map(output => {
      const matches = all.filter(entry => entry.tableId === output.tableId && entry.field.id === output.fieldId);
      return matches.length === 1 && output.tableId === trigger.tableId && matches[0].field.componentId === 'xform-input'
        ? {...output, sourceRef: matches[0].field.sourceRef} : undefined;
    });
    if (targets.some(target => !target)) return [];
    resolved.push({...branch, tableId: trigger.tableId, outputs: targets, controlSourceRef: trigger.field.sourceRef});
  }
  if (!resolved.length || new Set(resolved.map(branch => `${branch.tableId}.${branch.controlId}`)).size !== resolved.length) return [];
  const sourceRef = source.sourceRef || source.id;
  return resolved.map(branch => ({
    index: branch.start,
    event: 'onChange', scope: 'control', controlId: branch.controlId, tableId: branch.tableId,
    javascript: text,
    function: renderHydration(branch),
    translationStatus: 'mapped',
    coverage: {status: 'translated', nativeRules: [], residuals: []},
    functionMappings: [{source: 'KMSSData organization lookup and same-row positional output projection',
      target: 'detail address onChange + MKXFORM.callOrg + MKXFORM.updateControl',
      basis: LEGACY_DETAIL_ORG_HYDRATION_BASIS, reviewRequired: false}],
    sourceRefs: [sourceRef, branch.controlSourceRef, ...branch.outputs.map(output => output.sourceRef)].filter(Boolean),
    semanticHints: {
      detailOrgHydration: {tableId: branch.tableId, controlId: branch.controlId, queryKind: branch.kind,
        outputs: branch.outputs.map(({fieldId, property}) => ({fieldId, property})), absentBranches: absent,
        ...(currentDomain ? {sourceDomain: currentDomain} : {}),
        exportedControlIds: all.map(entry => entry.tableId ? `${entry.tableId}.${entry.field.id}` : entry.field.id).sort()},
      coveredLegacyFunctions: ['XFormOnValueChangeFuns.push', 'KMSSData', 'Data_GetOrgPersonBeanNameByKey',
        'Data_GetOrgElementBeanNameByKey', 'DocListFunc_ReplaceIndex', 'GetXFormFieldById', 'kmssdata.AddBeanData',
        'kmssdata.Parse', 'data.Format', 'data.GetHashMapArray'],
      coveredCalculationRanges: [{sourceRef, name: 'detailOrganizationHydration', start: 0, end: text.length}]
    }
  }));
}

function fields(form) {
  return (form.fields || []).flatMap(field => field?.type === 'detailTable'
    ? (field.columns || []).map(column => ({field: column, tableId: field.id})) : [{field}]);
}

function parseBranch(branch) {
  if (branch.type !== 'IfStatement' || branch.alternate || branch.consequent?.type !== 'BlockStatement') return undefined;
  const test = branch.test;
  if (test?.type !== 'BinaryExpression' || test.operator !== '>' || test.right?.value !== 0 ||
      test.left?.type !== 'CallExpression' || !member(test.left.callee, 'name', 'indexOf') || test.left.arguments.length !== 1) return undefined;
  const suffix = string(test.left.arguments[0]);
  const controlId = suffix?.match(/^([A-Za-z_][\w]*)\.id$/)?.[1];
  if (!controlId) return undefined;
  const list = branch.consequent.body;
  const mappings = list[1]?.declarations?.[0]?.init;
  if (mappings?.type !== 'ArrayExpression' || !mappings.elements.length) return undefined;
  const outputs = [];
  for (const item of mappings.elements) {
    if (item?.type !== 'ObjectExpression' || item.properties.length !== 2 || item.properties.some(prop => prop.type !== 'Property' || prop.computed || prop.method)) return undefined;
    const values = Object.fromEntries(item.properties.map(prop => [prop.key.name || prop.key.value, string(prop.value)]));
    if (Object.keys(values).sort().join(',') !== 'id,name') return undefined;
    const target = values.id?.match(/^extendDataFormInfo\.value\(([A-Za-z_][\w]*)\.!\{index\}\.([A-Za-z_][\w]*)\)$/);
    if (!target || !values.name) return undefined;
    outputs.push({tableId: target[1], fieldId: target[2], property: values.name, sourceId: values.id});
  }
  const query = list[7]?.expression?.arguments?.[0];
  const queryKind = query?.callee?.name;
  const kind = queryKind === 'Data_GetOrgPersonBeanNameByKey' ? 'person' : queryKind === 'Data_GetOrgElementBeanNameByKey' ? 'element' : undefined;
  const projection = string(query?.arguments?.[1]);
  const format = list[8]?.expression?.arguments?.[0]?.body?.body?.[0]?.expression?.arguments?.[0];
  const names = string(format);
  if (!kind || !projection || !names || query.arguments.length !== 2) return undefined;
  const allowed = kind === 'person' ? personProperties : elementProperties;
  const columns = projection.split(':'), aliases = names.split(':');
  if (columns.length !== aliases.length || outputs.some(output => !allowed.has(output.property) ||
      aliases.indexOf(output.property) < 0 || aliases.filter(alias => alias === output.property).length !== 1 ||
      columns[aliases.indexOf(output.property)] !== output.property)) return undefined;
  const expected = `if(name.indexOf(${JSON.stringify(suffix)})>0){
    var pId=value[0];var toIDs=${JSON.stringify(outputs.map(output => ({name: output.property, id: output.sourceId})))};
    var s=name.substring(name.indexOf('(')+1);s=s.substring(0,s.indexOf(')'));var index=s.split('.')[1];
    var kmssdata=new KMSSData();kmssdata.UseCache=false;
    kmssdata.AddBeanData(${queryKind}("'"+pId+"'",${JSON.stringify(projection)}));
    kmssdata.Parse(function(data){data.Format(${JSON.stringify(names)},null,false);data=data.GetHashMapArray();
      if(data.length==1){for(var i=0;i<toIDs.length;i++){var tId=DocListFunc_ReplaceIndex(toIDs[i]['id'],index);GetXFormFieldById(tId)[0].value=data[0][toIDs[i]['name']]||'';}}});}`;
  if (compact(branch) !== compact(parseProgram(expected)?.body?.[0])) return undefined;
  return {controlId, kind, outputs, start: branch.start, end: branch.end};
}

function renderHydration(branch) {
  const api = branch.kind === 'person' ? 'sysorg.getPersonByPersonId' : 'sysorg.getElementDatas';
  const param = branch.kind === 'person' ? '{fdPersonId: selected.fdId}' : '{address: [{fdId: selected.fdId}]}';
  return ['function onChange(value, rowNum, parentRowNum) {',
    '  var selected = Array.isArray(value) ? value[0] : value',
    '  if (!selected || !selected.fdId || typeof rowNum !== "number" || rowNum < 0 || rowNum % 1 !== 0) return',
    '  if (parentRowNum !== undefined && parentRowNum !== null) return',
    `  MKXFORM.callOrg({id: ${JSON.stringify(api)}, param: ${param}}, function(error, result) {`,
    ...(branch.kind === 'element' ? ['    result = Array.isArray(result) && result.length === 1 ? result[0] : null'] : []),
    '    if (error || !result || result.fdId !== selected.fdId) return',
    ...branch.outputs.map(output => `    MKXFORM.updateControl(${JSON.stringify(`\${table:${branch.tableId}}.${output.fieldId}`)}, rowNum, result[${JSON.stringify(output.property)}] || "")`),
    '  })', '}'].join('\n');
}
