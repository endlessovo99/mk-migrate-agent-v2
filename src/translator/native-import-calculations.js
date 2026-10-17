import {parse,parseExpressionAt} from "acorn";
import crypto from "node:crypto";
import {localCurrencyHelperCandidates,isPureLocalCurrencyHelperDeclaration} from "./local-currency-helper.js";

const idPattern=/^[A-Za-z_][A-Za-z0-9_]*$/u;
const fail=(message)=>{throw new Error(message);};
function arithmetic(expression,fieldIds){
  const replaced=expression.replace(/\$([A-Za-z_][\w]*)\$/gu,(_,id)=>'__field_'+id);
  let tree;try{tree=parseExpressionAt(replaced,0,{ecmaVersion:2022});}catch{fail('Unsupported native formula arithmetic.');}
  if(replaced.slice(tree.end).trim())fail('Trailing native formula effects.');
  const used=new Set();
  function check(node){
    if(node.type==='Literal'&&typeof node.value==='number'&&Number.isFinite(node.value))return;
    if(node.type==='Identifier'&&node.name.startsWith('__field_')){used.add(node.name.slice(8));return;}
    if(node.type==='BinaryExpression'&&['+','-','*','/','%'].includes(node.operator)){check(node.left);check(node.right);return;}
    if(node.type==='UnaryExpression'&&['+','-'].includes(node.operator)){check(node.argument);return;}
    fail('Unsupported native formula operation.');
  }
  check(tree);
  if(used.size!==fieldIds.length||fieldIds.some(id=>!used.has(id)))fail('Formula field declaration differs from expression.');
}

export function buildNativeLocalFormulaSpec(table){
  if(!table||table.type!=='detailTable'||!idPattern.test(table.id)||!Array.isArray(table.columns))fail('A static native detail table is required.');
  const names=new Set();for(const field of table.columns){if(!idPattern.test(field.id)||names.has(field.id))fail('Ambiguous local formula field.');names.add(field.id);}
  const formulas=[];
  for(const field of table.columns){
    const props=field.props||{},calculation=props.calculation;
    if(!calculation)continue;
    if(field.componentId!=='xform-calculate'||field.type!=='number'||calculation.kind!=='formula'||typeof calculation.expression!=='string'||!calculation.expression.trim())fail('Only existing numeric native formulas are supported.');
    const dependencies=calculation.fieldIds;
    if(!Array.isArray(dependencies)||!dependencies.length||new Set(dependencies).size!==dependencies.length||dependencies.some(id=>!names.has(id)))fail('Formula dependency is not uniquely bound to this table.');
    if(dependencies.some(id=>table.columns.find(c=>c.id===id).type!=='number'))fail('Formula dependency must retain its numeric source type.');
    const precision=props.precision??2;
    if(!Number.isInteger(precision)||precision<0||precision>20)fail('Unsupported native decimal precision.');
    arithmetic(calculation.expression,dependencies);
    formulas.push({id:field.id,expression:calculation.expression,fieldIds:[...dependencies],formatType:'decimal',precision});
  }
  if(!formulas.length)fail('No existing native formula is declared.');
  const pending=[...formulas],ordered=[];
  while(pending.length){const index=pending.findIndex(f=>f.fieldIds.every(id=>!pending.some(p=>p.id===id)));if(index<0)fail('Native formula dependency cycle.');ordered.push(...pending.splice(index,1));}
  return {version:1,profile:'same-table-native-formula-precompute-v1',tableId:table.id,formulas:ordered};
}

/**
 * Narrow native-$n equivalent: current-table Eval arithmetic only, decimal outputs.
 * Public config/value getters only; no guessed $$form instance or automatic recalc.
 * The caller must retain its parse/preview/confirm cancellation ticket and call the
 * setter only after this Promise completes and the user confirms replacement.
 */
export function nativeLocalFormulaRows(spec,parsedRows,MKXFORM,base,isCurrent){
  if(typeof isCurrent!=='function')isCurrent=function(){return true;};
  function stop(message){throw new Error(message);}
  function current(){if(!isCurrent())stop('Native formula request cancelled.');}
  function object(value){return value&&typeof value==='object'&&!Array.isArray(value);}
  if(!spec||spec.version!==1||spec.profile!=='same-table-native-formula-precompute-v1'||!Array.isArray(spec.formulas)||!spec.formulas.length||!Array.isArray(parsedRows))stop('Invalid native formula plan.');
  if(!base||typeof base.requestBatchToFormulaExecute!=='function'||typeof base.toFixed!=='function')stop('Native formula public module is unavailable.');
  current();
  const nativeModels=MKXFORM.dataModels;
  if(!Array.isArray(nativeModels))stop('Native formula table/alias metadata is unavailable.');
  const relatedModels=nativeModels.filter(model=>model&&(model.fdTableName===spec.tableId||model.fdTableNameAlias===spec.tableId));
  if(relatedModels.length!==1||relatedModels[0].fdTableName!==spec.tableId||relatedModels[0].fdTableNameAlias!==spec.tableId)stop('Native formula table alias is ambiguous or mismatched.');
  const config=MKXFORM.getFormConfigs(),values=MKXFORM.getFormValues();
  if(!config||!Array.isArray(config.forms)||!object(values)||!object(values._systemValues))stop('Native formula public context is unavailable.');
  const controls=[],keys=new Set(),tables=[];
  function visit(node){
    if(!object(node))return;
    if(node.childrenGroup||node.tempConfig||node.options?.tempConfig)stop('Grouped native formula context is unsupported.');
    const p=node.controlProps;
    if(object(p)&&p.$$tableType==='detail'&&p.$$tableName===spec.tableId&&['@elem/xform-detail-table','@elem/xform-m-detail-table'].includes(node.type)&&Array.isArray(p.columns))tables.push(node);
    if(node.kind==='control'){
      if(!object(p)||typeof node.key!=='string'||keys.has(node.key))stop('Ambiguous native formula control identity.');
      keys.add(node.key);
      if(p.$$tableType==='detail'&&p.$$tableName===spec.tableId&&(node.type==='@elem/xform-calculate'||p.type==='@elem/xform-calculate'))controls.push(node);
    }
    if(object(p)&&Array.isArray(p.columns))p.columns.forEach(visit);
    if(Array.isArray(node.items))node.items.forEach(visit);
    if(Array.isArray(node.children))node.children.forEach(visit);
  }
  config.forms.forEach(visit);
  if(tables.length!==1||controls.length!==spec.formulas.length)stop('Native detail/formula binding is not unique.');
  const plans=spec.formulas.map(formula=>{
    const found=controls.filter(c=>c.controlProps.name===formula.id);
    if(found.length!==1)stop('Native formula field is not uniquely bound.');
    const p=found[0].controlProps,vo=p.expressionFormulaVO;
    const script=formula.expression.replace(/\$([A-Za-z_][\w]*)\$/gu,(_,id)=>'${data.biz.'+spec.tableId+'.'+id+'}');
    if(p.statisticMode!=='FORMULA'||!object(vo)||vo.type!=='Eval'||vo.script!==script||!Array.isArray(vo.varIds)||JSON.stringify(vo.varIds)!==JSON.stringify(formula.fieldIds.map(id=>spec.tableId+'.'+id))||p.valueType?.formatType!==formula.formatType||p.valueType?.precision!==formula.precision)stop('Runtime native formula differs from its sealed plan.');
    const raw=p.$$sign?.expressionFormulaVO,sign=object(raw)?raw.value:raw;
    if(typeof sign!=='string'||!sign)stop('Native formula signature is unavailable.');
    return {formula,script,sign};
  });
  const ambient=Object.assign({},values._systemValues);delete ambient[spec.tableId];
  const rows=parsedRows.map(row=>{if(!object(row))stop('Parsed native row is invalid.');return Object.assign({},row);});
  let chain=Promise.resolve();
  for(let offset=0;offset<rows.length;offset+=100){
    const chunk=rows.slice(offset,offset+100);
    for(const {formula,script,sign} of plans){
      chain=chain.then(function(){
        current();
        const dataList=chunk.map(row=>{const biz=Object.assign({},ambient);for(const id of formula.fieldIds)if(Object.prototype.hasOwnProperty.call(row,id))biz[spec.tableId+'.'+id]=row[id];return {biz};});
        return Promise.resolve(base.requestBatchToFormulaExecute({dataList,sign,script},'')).then(function(response){
          current();
          const body=response?.data,result=body?.data;
          if(!body||body.success===false||!Array.isArray(result)||result.length!==chunk.length)stop('Native formula response is incomplete or failed.');
          for(let i=0;i<result.length;i+=1){
            const value=result[i];
            if((typeof value!=='number'&&typeof value!=='string')||value===''||!Number.isFinite(Number(value)))stop('Native formula result is not finite numeric data.');
            const formatted=base.toFixed(value,formula.precision);
            if(typeof formatted!=='string'||!formatted||!Number.isFinite(Number(formatted)))stop('Native formula decimal formatting failed.');
            // Exact native su truthiness is retained for this decimal-only profile:
            // base.toFixed always yields a truthy numeric string, including "0.00".
            chunk[i][formula.id]=formatted;
          }
        });
      });
    }
  }
  return chain.then(function(){current();return rows;});
}

export function buildNativeImportCalculationSpec(draft,tableId,sourceDraft){
  const table=draft?.form?.fields?.filter(f=>f.id===tableId);
  if(table?.length!==1||!Array.isArray(draft?.scripts?.actions))throw new Error('Calculation source binding is incomplete.');
  const rowPlan=buildNativeLocalFormulaSpec(table[0]),mainSums=[];
  for(const field of draft.form.fields)for(const item of [field,...(field.columns||[])])if(item.props?.formula!==undefined||item.type==='calculation')throw new Error('Unsupported calculation declaration.');
  for(const field of draft.form.fields){
    const c=field.props?.calculation;
    if(field.type==='detailTable'){
      if(field.id!==tableId&&(field.columns||[]).some(column=>column.props?.calculation))throw new Error('Other table calculations are outside this import profile.');
      continue;
    }
    if(!c)continue;
    if(field.type!=='number'||field.componentId!=='xform-calculate'||c.kind!=='aggregate'||c.operation!=='sum'||c.tableId!==tableId||!rowPlan.formulas.some(f=>f.id===c.fieldId))throw new Error('Only declared current-table numeric SUM is supported.');
    const precision=field.props.precision??2;
    if(!Number.isInteger(precision)||precision<0||precision>20)throw new Error('Unsupported native SUM precision.');
    mainSums.push({id:field.id,tableId,fieldId:c.fieldId,precision,formatType:'decimal'});
  }
  if(!mainSums.length)throw new Error('No declared native main SUM was found.');
  const affected=new Set([...rowPlan.formulas.map(f=>f.id),...mainSums.map(f=>f.id)]);
  if(draft.scripts.actions.some(action=>affected.has(action.controlId)&&action.event!=='onChange'))throw new Error('Calculated control has an unknown callback.');
  const currencyEffects=[];
  for(const action of draft.scripts.actions.filter(action=>action.event==='onChange'&&affected.has(action.controlId))){
    if(!mainSums.some(sum=>sum.id===action.controlId)||!sourceDraft)throw new Error('Calculated control has an unproven source onChange side effect.');
    const matches=[];
    for(const source of sourceDraft.scripts?.sources||[]){
      if(!(action.sourceRefs||[]).includes(source.sourceRef))continue;
      for(const candidate of localCurrencyHelperCandidates(source,draft.form))if(candidate.controlId===action.controlId&&candidate.function===action.function&&candidate.sourceActionKey===action.sourceActionKey)matches.push({source,candidate});
    }
    if(matches.length!==1)throw new Error('Calculated source side effect is not the trusted pure currency helper.');
    const {source,candidate}=matches[0];
    const viewStatusIn=action.runWhen?.viewStatusIn||[];
    if(action.runWhen&&Object.keys(action.runWhen).some(key=>key!=='viewStatusIn')||![JSON.stringify([]),JSON.stringify(['add','edit'])].includes(JSON.stringify(viewStatusIn))||(source.displayGate==='xform:editShow')!==(viewStatusIn.length>0))throw new Error('Currency source view gate is unproven.');
    const tree=parse(candidate.function,{ecmaVersion:'latest'}),body=tree.body[0].body.body,helper=body.find(statement=>statement.type==='FunctionDeclaration'),setter=body.find(statement=>statement.type==='ExpressionStatement')?.expression;
    const targetId=setter?.arguments?.[0]?.value,targets=draft.form.fields.filter(field=>field.id===targetId);
    if(targets.length!==1||!['text','longText'].includes(targets[0].type)||targets[0].props?.calculation||draft.scripts.actions.some(a=>a.controlId===targetId))throw new Error('Currency target binding or further side effect is unproven.');
    const digest=text=>'sha256:'+crypto.createHash('sha256').update(text).digest('hex');
    const helperSource=candidate.function.slice(helper.start,helper.end);
    if(!isPureLocalCurrencyHelperDeclaration(helperSource))throw new Error('Currency helper declaration is not pure.');
    currencyEffects.push({viewStatusIn:[...viewStatusIn],actionId:action.id,triggerId:action.controlId,targetId,sourceRef:source.sourceRef,sourceJavascriptSha256:digest(source.javascript),compiledFunctionSha256:digest(candidate.function),compiledFunction:candidate.function,helperName:helper.id.name,helperSource,helperSha256:digest(helperSource),coveredCalculationRanges:candidate.semanticHints.coveredCalculationRanges});
  }
  const plan = {...rowPlan,mainSums,currencyEffects};
  const validation = validateNativeImportCalculationPlan(plan);
  if (!validation.ok) throw new Error(validation.diagnostics[0].message);
  return plan;
}

export function nativeDeclaredMainSums(spec,rows,MKXFORM,base){
  if(!base||typeof base.Big!=='function'||typeof base.toFixed!=='function'||!Array.isArray(rows)||!Array.isArray(spec.mainSums)||!spec.mainSums.length)throw new Error('Native SUM dependencies are unavailable.');
  const models=MKXFORM.dataModels;
  if(!Array.isArray(models)||models.filter(m=>m&&(m.fdTableName===spec.tableId||m.fdTableNameAlias===spec.tableId)).length!==1||!models.some(m=>m.fdTableName===spec.tableId&&m.fdTableNameAlias===spec.tableId))throw new Error('Native SUM table alias is unproven.');
  const config=MKXFORM.getFormConfigs(),controls=[];
  if(!config||!Array.isArray(config.forms))throw new Error('Native SUM public config is unavailable.');
  function visit(node){if(!node||typeof node!=='object')return;if(node.childrenGroup||node.tempConfig||node.options?.tempConfig)throw new Error('Grouped SUM config is unsupported.');if(node.kind==='control')controls.push(node);if(Array.isArray(node.controlProps?.columns))node.controlProps.columns.forEach(visit);if(Array.isArray(node.items))node.items.forEach(visit);if(Array.isArray(node.children))node.children.forEach(visit);}
  config.forms.forEach(visit);
  for(const effect of spec.currencyEffects||[]){
    const targets=controls.filter(control=>control.controlProps?.$$tableType==='main'&&control.controlProps.name===effect.targetId);
    if(targets.length!==1||!['@elem/xform-input','@elem/xform-textarea'].includes(targets[0].type)||targets[0].controlProps.controlActions&&Object.keys(targets[0].controlProps.controlActions).length)throw new Error('Native currency target or further hook is unproven.');
  }
  const values={};
  for(const sum of spec.mainSums){
    const main=controls.filter(c=>c.controlProps?.$$tableType==='main'&&c.controlProps.name===sum.id),columns=controls.filter(c=>c.controlProps?.$$tableType==='detail'&&c.controlProps.$$tableName===spec.tableId&&c.controlProps.name===sum.fieldId);
    if(main.length!==1||columns.length!==1)throw new Error('Declared SUM target/source is not uniquely bound.');
    const p=main[0].controlProps,column=columns[0],cp=column.controlProps;
    if(main[0].type!=='@elem/xform-calculate'||p.statisticMode!=='SUM'||!Array.isArray(p.statisticData)||p.statisticData.length!==1||p.statisticData[0]!==spec.tableId+'.'+sum.fieldId||p.valueType?.formatType!==sum.formatType||p.valueType?.precision!==sum.precision)throw new Error('Native SUM config differs from its declared plan.');
    const effects=(spec.currencyEffects||[]).filter(effect=>effect.triggerId===sum.id),actions=p.controlActions||{};
    if(cp.controlActions&&Object.keys(cp.controlActions).length)throw new Error('Native SUM input side effect is unproven.');
    if(!effects.length&&Object.keys(actions).length)throw new Error('Native SUM custom side effect is unproven.');
    if(effects.length){
      if(Object.keys(actions).length!==1||!Array.isArray(actions.onChange)||actions.onChange.length!==effects.length)throw new Error('Native currency binding is incomplete.');
      for(const effect of effects){const actual=actions.onChange.filter(function(a){
        if(typeof a?.name!=='string'||!/^onChange_[0-9]+$/.test(a.name)||typeof a.function!=='function')return false;
        var expected=effect.compiledFunction.replace(/^function onChange\(/,'function '+a.name+'(');
        if(effect.viewStatusIn.length){var start=expected.indexOf('{')+1;var condition=effect.viewStatusIn.map(status=>'MKXFORM.viewStatus !== '+JSON.stringify(status)).join(' && ');var guard='\n  /* mk-migrate:view-status='+effect.viewStatusIn.join(',')+' */\n  if ('+condition+') return;';expected=expected.slice(0,start)+guard+expected.slice(start);}
        return a.function.toString()===expected;
      });if(actual.length!==1)throw new Error('Native currency callback differs from its exact source helper.');}
    }
    if(column.type!=='@elem/xform-calculate'||cp.statisticMode!=='FORMULA'||cp.valueType?.formatType!=='decimal'||cp.numberFormat?.formatType==='percent')throw new Error('Native SUM input percent/type conversion is unproven.');
    // Exact native ee and 272-byte SUM node, bound only to public base.Big.
    var t=base;
    var ee=function(e){if(!Array.isArray(e))return[];var r=[];return e.forEach((function(e){return Array.isArray(e)?r=r.concat(e):r.push(e)})),r};
    var SUM=function(){for(var e=arguments.length,r=new Array(e),n=0;n<e;n++)r[n]=arguments[n];if(Array.isArray(r)){var o=t.Big(0),a=ee(r);return a.forEach((function(e){if(e instanceof t.Big)o=o.plus(e);else{var r=null==e||isNaN(Number(e))?0:e;o=o.plus(t.Big(r+""))}})),o.toNumber()}};
    const parsed=[];
    rows.forEach(function(row){if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('Invalid native SUM row.');const value=row[sum.fieldId];if(value!==null&&value!==undefined&&!['string','number','boolean'].includes(typeof value))throw new Error('Nonprimitive native SUM input is unsupported.');var number=parseFloat(value);if(number||number===0)parsed.push(number);});
    var result=SUM(parsed)||0;
    result=parseFloat(base.toFixed(result,sum.precision));
    if(!Number.isFinite(result))throw new Error('Native SUM produced a nonfinite result.');
    values[sum.id]=result;
  }
  return values;
}

export function nativeImportCalculationPreview(spec,rows,MKXFORM,base,isCurrent,currencyComputations){
  return nativeLocalFormulaRows(spec,rows,MKXFORM,base,isCurrent).then(function(computedRows){
    if(typeof isCurrent==='function'&&!isCurrent())throw new Error('Native import calculation cancelled.');
    const mainValues=nativeDeclaredMainSums(spec,computedRows,MKXFORM,base);
    if(typeof isCurrent==='function'&&!isCurrent())throw new Error('Native import calculation cancelled.');
    const effects=spec.currencyEffects||[],computations=currencyComputations||[],currencyValues={};
    if(computations.length!==effects.length)throw new Error('Native currency computation binding is incomplete.');
    for(let i=0;i<effects.length;i+=1){if(typeof computations[i]!=='function')throw new Error('Native currency pure function is unavailable.');const value=computations[i](mainValues[effects[i].triggerId]);if(typeof value!=='string')throw new Error('Native currency pure function result is invalid.');currencyValues[effects[i].targetId]=value;}
    return {rows:computedRows,mainValues,currencyValues};
  });
}

/** Compile-time only: caller must obtain effects by rebuilding the source-bound plan. */
export function nativeCurrencyComputationSources(spec){const validation=validateNativeImportCalculationPlan(spec);if(!validation.ok)throw new Error(validation.diagnostics[0].message);return (spec.currencyEffects||[]).map(effect=>{if(!isPureLocalCurrencyHelperDeclaration(effect.helperSource))throw new Error('Unsafe currency helper declaration.');return 'function(value) {\n'+effect.helperSource+'\nreturn '+effect.helperName+'(value);\n}';});}

/** Shape/code safety only; source identity must be rebuilt independently. */
export function validateNativeImportCalculationPlan(plan) {
  const diagnostics = [];
  const fail = message => { throw new Error(message); };
  const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
  const identifier = value => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,24}$/.test(value) && !["__proto__", "constructor", "prototype", "mechanisms"].includes(value);
  const text = value => typeof value === "string" && value.length > 0 && value.length <= 512;
  const digest = value => "sha256:" + crypto.createHash("sha256").update(value).digest("hex");
  const sha = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
  const precision = value => Number.isInteger(value) && value >= 0 && value <= 20;
  try {
    if (!exact(plan, ["version", "profile", "tableId", "formulas", "mainSums", "currencyEffects"]) || plan.version !== 1 || plan.profile !== "same-table-native-formula-precompute-v1" || !identifier(plan.tableId)) fail("Invalid native calculation profile.");
    if (!Array.isArray(plan.formulas) || !plan.formulas.length || plan.formulas.length > 64) fail("Invalid formula collection.");
    const formulaIds = new Set();
    for (const f of plan.formulas) {
      if (!exact(f, ["id", "expression", "fieldIds", "formatType", "precision"]) || !identifier(f.id) || formulaIds.has(f.id) || typeof f.expression !== "string" || f.expression.length > 4096 || f.formatType !== "decimal" || !precision(f.precision) || !Array.isArray(f.fieldIds) || !f.fieldIds.length || f.fieldIds.length > 64 || !f.fieldIds.every(identifier) || new Set(f.fieldIds).size !== f.fieldIds.length) fail("Invalid native local formula.");
      arithmetic(f.expression, f.fieldIds); formulaIds.add(f.id);
    }
    const emitted = new Set();
    for (const f of plan.formulas) {
      if (f.fieldIds.some(id => formulaIds.has(id) && !emitted.has(id))) fail("Formula dependency is cyclic or unordered.");
      emitted.add(f.id);
    }
    if (!Array.isArray(plan.mainSums) || !plan.mainSums.length || plan.mainSums.length > 64) fail("Invalid main SUM collection.");
    const sumIds = new Set();
    for (const sum of plan.mainSums) {
      if (!exact(sum, ["id", "tableId", "fieldId", "precision", "formatType"]) || !identifier(sum.id) || sumIds.has(sum.id) || formulaIds.has(sum.id) || sum.tableId !== plan.tableId || !formulaIds.has(sum.fieldId) || sum.formatType !== "decimal" || !precision(sum.precision)) fail("Invalid native main SUM.");
      sumIds.add(sum.id);
    }
    if (!Array.isArray(plan.currencyEffects) || plan.currencyEffects.length > 64) fail("Invalid pure currency effects.");
    const targetIds = new Set(), actionIds = new Set();
    for (const effect of plan.currencyEffects) {
      if (!exact(effect, ["actionId", "triggerId", "targetId", "sourceRef", "sourceJavascriptSha256", "compiledFunctionSha256", "compiledFunction", "helperName", "helperSource", "helperSha256", "coveredCalculationRanges", "viewStatusIn"]) || !Array.isArray(effect.viewStatusIn) || !["[]", '["add","edit"]'].includes(JSON.stringify(effect.viewStatusIn)) || !text(effect.actionId) || actionIds.has(effect.actionId) || !sumIds.has(effect.triggerId) || !identifier(effect.targetId) || targetIds.has(effect.targetId) || sumIds.has(effect.targetId) || formulaIds.has(effect.targetId) || !text(effect.sourceRef) || !sha(effect.sourceJavascriptSha256) || !sha(effect.compiledFunctionSha256) || !sha(effect.helperSha256) || effect.helperName !== "convertCurrency" || typeof effect.helperSource !== "string" || effect.helperSource.length > 20000 || !isPureLocalCurrencyHelperDeclaration(effect.helperSource) || digest(effect.helperSource) !== effect.helperSha256 || typeof effect.compiledFunction !== "string" || effect.compiledFunction.length > 24000 || digest(effect.compiledFunction) !== effect.compiledFunctionSha256) fail("Invalid pure currency effect or digest.");
      const program = parse(effect.compiledFunction, { ecmaVersion: "latest" }), fn = program.body[0], body = fn?.body?.body;
      if (program.body.length !== 1 || fn.type !== "FunctionDeclaration" || fn.id?.name !== "onChange" || fn.async || fn.generator || fn.params.length !== 3 || fn.params.some((p, i) => p.type !== "Identifier" || p.name !== ["value", "rowNum", "parentRowNum"][i]) || body?.length !== 2 || body[0].type !== "FunctionDeclaration" || body[0].id?.name !== effect.helperName || effect.compiledFunction.slice(body[0].start, body[0].end) !== effect.helperSource) fail("Currency wrapper does not retain the exact pure helper.");
      const call = body[1]?.expression, inner = call?.arguments?.[1];
      if (body[1].type !== "ExpressionStatement" || call?.type !== "CallExpression" || call.optional || call.callee?.type !== "MemberExpression" || call.callee.computed || call.callee.object?.name !== "MKXFORM" || call.callee.property?.name !== "setValue" || call.arguments.length !== 2 || call.arguments[0]?.type !== "Literal" || call.arguments[0].value !== effect.targetId || inner?.type !== "CallExpression" || inner.optional || inner.callee?.name !== effect.helperName || inner.arguments.length !== 1 || inner.arguments[0]?.type !== "Identifier" || inner.arguments[0].name !== "value") fail("Currency wrapper must contain exactly one declared assignment.");
      const ranges = effect.coveredCalculationRanges;
      if (!Array.isArray(ranges) || ranges.length !== 1 || !exact(ranges[0], ["sourceRef", "name", "start", "end"]) || ranges[0].sourceRef !== effect.sourceRef || ranges[0].name !== effect.helperName || !Number.isInteger(ranges[0].start) || ranges[0].start < 0 || !Number.isInteger(ranges[0].end) || ranges[0].end <= ranges[0].start) fail("Invalid currency source range shape.");
      actionIds.add(effect.actionId); targetIds.add(effect.targetId);
    }
  } catch (cause) { diagnostics.push({ level: "error", code: "native_import.calculation_plan_invalid", message: cause.message }); }
  return { ok: diagnostics.length === 0, diagnostics };
}
