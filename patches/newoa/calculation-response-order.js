import { createHash } from "node:crypto";
import { parse } from "acorn";

export const NATIVE_CALCULATION_BASE_SHA256 = "284eba94bd9befb4652c78288d8f508e09c6bfffea7cc6b15c0de213985af523";

// Offline vendor-asset patch. It is not injected by the migration executor.
export function patchNativeCalculationResponseOrder(source) {
  if (typeof source !== "string" || createHash("sha256").update(source).digest("hex") !== NATIVE_CALCULATION_BASE_SHA256) {
    throw new Error("Unsupported native calculation asset; no patch applied.");
  }
  const tree = parse(source, { ecmaVersion: "latest" });
  const component = findOne(tree, node => node.type === "VariableDeclarator" &&
    node.id?.name === "S" && node.init?.type === "FunctionExpression" &&
    source.slice(node.init.start, node.init.end).includes("requestToFormulaExecute")).init;
  const request = findOne(component, node => node.type === "VariableDeclarator" &&
    node.id?.name === "oe" && node.init?.type === "FunctionExpression").init;
  let replacement = source.slice(request.start, request.end);
  replacement = replaceOne(replacement, "function(){return T", `function(){
    if(!__mkCalcOwnsRequest())return;
    var __mkCalcTicket=++__mkCalcLife.current.version,__mkCalcInput;
    return T`);
  replacement = replaceOne(replacement,
    "a=o&&t.getFormulaVariableValue(b,M,o,n,k),",
    "a=o&&t.getFormulaVariableValue(b,M,o,n,k),__mkCalcInput=JSON.stringify(a),");
  replacement = replaceOne(replacement, "case 15:d=e.sent,", `case 15:
    if(!__mkCalcAccepts(__mkCalcTicket,__mkCalcInput,o,n))return e.abrupt("return");
    d=e.sent,`);

  const lifecycle = `
    var __mkCalcLife=r.useRef({mounted:true,version:0,owner:null});
    function __mkCalcLiveOwner(){
      return [i,w,N,M,S,j,m,x,A,k&&k.docStatus,e.docId,e.formId,b,b&&b.current,
        p&&p.script,p&&p.type,p&&JSON.stringify(p.varIds),s&&s.formatType,s&&s.precision];
    }
    var __mkCalcOwner=__mkCalcLiveOwner();
    function __mkCalcOwnsRequest(){
      var state=__mkCalcLife.current,live=__mkCalcLiveOwner();
      return state.mounted&&state.owner&&state.owner.length===__mkCalcOwner.length&&
        state.owner.every(function(value,index){return value===__mkCalcOwner[index]&&value===live[index]});
    }
    if(!__mkCalcOwnsRequest()){
      __mkCalcLife.current.version++;
      __mkCalcLife.current.owner=__mkCalcOwner;
    }
    r.useEffect(function(){
      var state=__mkCalcLife.current;
      state.mounted=true;
      return function(){state.mounted=false;state.version++};
    },[]);
    function __mkCalcAccepts(ticket,input,names,options){
      if(!__mkCalcOwnsRequest()||__mkCalcLife.current.version!==ticket)return false;
      try{
        if(N==="detail"&&!(b&&b.current&&b.current.highCode)){
          if(M===undefined||M===null||!w)return false;
          var rows=t.getValueByName(b,w+"."+String(l).split(".").pop(),e);
          if(!Array.isArray(rows)||!rows.some(function(row){return row&&row.key===M}))return false;
        }
        return input===JSON.stringify(names&&t.getFormulaVariableValue(b,M,names,options,k));
      }catch(error){return false}
    }
  `;
  const insertAt = component.body.body[0].end;
  const patched = source.slice(0, insertAt) + lifecycle +
    source.slice(insertAt, request.start) + replacement + source.slice(request.end);
  parse(patched, { ecmaVersion: "latest" });
  return patched;
}

function replaceOne(source, before, after) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error("Native calculation patch anchor is missing or ambiguous.");
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function findOne(root, predicate) {
  const matches = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (predicate(node)) matches.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(root);
  if (matches.length !== 1) throw new Error("Native calculation patch structure is not unique.");
  return matches[0];
}
