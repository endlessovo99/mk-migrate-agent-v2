import {parse} from "acorn";
import {buildJavaScriptBindingModel} from "../dsl/javascript-binding-provenance.js";

const member=(node,name)=>node?.type==="MemberExpression" && !node.computed && node.property.name===name;
const canonical=code=>JSON.stringify(parse(code,{ecmaVersion:"latest"}),(key,value)=>["start","end","raw"].includes(key)?undefined:value);
const lifecycle=["DocList_AddRow();XFom_RestValidationElements();controlDisplay2(0);addDelClick();",
  "DocList_DeleteRow_ClearLast();XFom_RestValidationElements();controlDisplay2(1);"].map(canonical);
const rowHandlers=["controlDisplay(this.value,__PROVEN_ROW__);",
  "__xformDispatch(this.value,document.getElementsByName(this.name));controlDisplay('__PROVEN_OPTION__',__PROVEN_ROW__);"].map(canonical);

/** Prove string interpolation provenance before classifying an omitted legacy handler. */
export function createDetailInlineHandlerProof(source,ast) {
  const model=buildJavaScriptBindingModel(source), parents=new WeakMap(), declarations=new Map(), updates=new Map();
  function visit(node,parent) {
    if (!node || typeof node!=="object") return;
    if (node.type) {
      parents.set(node,parent);
      if (node.type==="VariableDeclarator") declarations.set(node.id.start,node);
      if (node.type==="UpdateExpression") updates.set(node.start,node);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child=>visit(child,node));
      else if (value && typeof value==="object") visit(value,node);
    }
  }
  visit(ast);
  const binding=node=>node?.type==="Identifier" ? model.bindingAtUse(node.name,node.start):undefined;
  function numericCounter(node,loop) {
    const owner=binding(node);
    if (!owner || owner.scope.kind!=="function" || owner.kinds.size!==1 || !owner.kinds.has("var") || owner.aliases.size ||
        !owner.declarations.length || binding(loop?.init?.declarations?.[0]?.id)!==owner) return false;
    const validLoops=new Set();
    for (const entry of owner.declarations) {
      const declaration=declarations.get(entry.index), statement=parents.get(declaration), candidate=parents.get(statement);
      if (statement?.type!=="VariableDeclaration" || statement.declarations.length!==1 || candidate?.type!=="ForStatement" || candidate.init!==statement ||
          declaration.init?.type!=="Literal" || declaration.init.value!==0 ||
          candidate.update?.type!=="UpdateExpression" || candidate.update.operator!=="++" || binding(candidate.update.argument)!==owner ||
          model.scopeAt(candidate.start).functionScope!==owner.scope.functionScope) return false;
      validLoops.add(candidate);
    }
    return validLoops.has(loop) && owner.effects.filter(effect=>["write","mutation"].includes(effect.kind)).every(effect=>{
      const update=updates.get(effect.index), candidate=parents.get(update);
      return validLoops.has(candidate) && candidate.update===update;
    });
  }
  return (call,ancestors,{tableId,trigger})=>{
    try {
      if (!model.ok || call.arguments.length!==2) return false;
      const expression=call.arguments[1];
      if (expression.type==="Literal" && typeof expression.value==="string" && lifecycle.includes(canonical(expression.value))) return true;
      const receiver=call.callee.object, owner=binding(receiver), statement=parents.get(call), block=parents.get(statement);
      const declaration=block?.type==="BlockStatement" ? block.body[block.body.indexOf(statement)-1]:undefined;
      const initializer=owner?.declarations.length===1 ? declarations.get(owner.declarations[0].index):undefined;
      if (!owner || owner.ambiguous || owner.aliases.size || owner.effects.some(effect=>["write","mutation"].includes(effect.kind)) ||
          statement?.type!=="ExpressionStatement" || declaration?.type!=="VariableDeclaration" || declaration.declarations.length!==1 || declaration.declarations[0]!==initializer) return false;
      const lookup=initializer.init, address=lookup?.object?.arguments?.[0], row=address?.left?.right;
      if (lookup?.type!=="MemberExpression" || !lookup.computed || lookup.property.type!=="Literal" || !Number.isInteger(lookup.property.value) ||
          lookup.object?.type!=="CallExpression" || lookup.object.arguments.length!==1 || !member(lookup.object.callee,"getElementsByName") ||
          lookup.object.callee.object?.name!=="document" || !model.isUnshadowedGlobal("document",lookup.start) ||
          address?.type!=="BinaryExpression" || address.operator!=="+" || address.left?.type!=="BinaryExpression" || address.left.operator!=="+" ||
          address.left.left?.value!==`extendDataFormInfo.value(${tableId}.` || address.right?.value!==`.${trigger.id})`) return false;
      const loop=ancestors.findLast(node=>node.type==="ForStatement"), fn=ancestors.findLast(node=>/Function/.test(node.type));
      if (!fn || !loop || loop.start<fn.start || !numericCounter(row,loop)) return false;
      const options=trigger.props?.options;
      if (!Array.isArray(options) || !options.length || options.some(option=>typeof option.value!=="string" || !/^[A-Za-z0-9_-]+$/.test(option.value)) ||
          lookup.property.value<0 || lookup.property.value>=options.length) return false;
      const pieces=[];
      function preview(node) {
        if (node?.type==="Literal" && typeof node.value==="string") pieces.push({text:node.value});
        else if (node?.type==="BinaryExpression" && node.operator==="+") {preview(node.left);preview(node.right);}
        else if (node?.type==="Identifier" && binding(node)===binding(row) && numericCounter(node,loop)) pieces.push({text:"__PROVEN_ROW__",kind:"row"});
        else if (member(node,"value") && binding(node.object)===owner) pieces.push({text:"__PROVEN_OPTION__",kind:"option"});
        else throw Error("Unproved interpolation");
      }
      preview(expression);
      let code="";
      for (const piece of pieces) {piece.start=code.length;code+=piece.text;piece.end=code.length;}
      const handler=canonical(code), parsed=parse(code,{ecmaVersion:"latest"}), args=parsed.body.at(-1)?.expression?.arguments;
      const rows=pieces.filter(piece=>piece.kind==="row"), values=pieces.filter(piece=>piece.kind==="option");
      // Match generated interpolation spans to the exact call arguments. Counting
      // placeholders alone would also count interpolation hidden inside comments.
      if (rows.length!==1 || args?.[1]?.start!==rows[0].start || args[1].end!==rows[0].end) return false;
      return handler===rowHandlers[0] && values.length===0 || handler===rowHandlers[1] && values.length===1 &&
        args[0].start===values[0].start-1 && args[0].end===values[0].end+1;
    } catch {return false;}
  };
}
