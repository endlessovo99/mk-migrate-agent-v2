import { parse } from "acorn";
import { sourceFunctionShape } from "./source-form-value-reader.js";

const SUM = parse(`function sumValues(tableId,controlId){var tab_id='TABLE_DL_'+tableId;var tbInfo=DocList_TableInfo[tab_id];var sum=0;if(typeof(tbInfo)!="undefined"){for(var i=0;i<tbInfo.lastIndex-1;i++){var child_id=tableId+"."+i+"."+controlId;var current_value=$("[name='extendDataFormInfo.value("+child_id+")']").val();sum=roundValue(sum+Number(current_value));}}return sum;}`, { ecmaVersion: "latest" }).body[0];
const ROUND = parse("function roundValue(value){var precision=2;var power=Math.pow(10,precision);return Math.round(value*power)/power;}", { ecmaVersion: "latest" }).body[0];
const FILTERED = parse(`function aggregate(tableId,controlId,output,kind){var tab_id='TABLE_DL_'+tableId;var tbInfo=DocList_TableInfo[tab_id];var sum=0;var count=0;if(typeof(tbInfo)!="undefined"){for(var i=0;i<tbInfo.lastIndex-1;i++){var child_id=tableId+"."+i+"."+controlId;var value=$("[name='extendDataFormInfo.value("+child_id+")']").val();var radioId=tableId+"."+i+"."+'__radio__';var selected=$("input[name='extendDataFormInfo.value("+radioId+")']:checked").val();if(kind==='__kind1__'&&selected==='__value1__'){sum=roundValue(sum+Number(value));}else if(kind==='__kind2__'&&selected==='__value2__'){count++;sum=roundValue(sum+Number(value));}else if(kind==='__kind3__'&&selected==='__value3__'){sum=roundValue(sum+Number(value));}}}if(kind==='__kind2__'){SetXFormFieldValueById("__counter__",count);}output.val(sum);return sum;}`, { ecmaVersion: "latest" }).body[0];

export const sourceDecimalRounder = (node, reserved) => sourceFunctionShape(node, ROUND, reserved);

export function sourceDetailSumReader(node, reserved) {
  const calls = [];
  walk(node?.body, item => { if (item.type === "CallExpression" && item.callee.type === "Identifier" && !["$", "Number"].includes(item.callee.name)) calls.push(item.callee.name); });
  const names = [...new Set(calls)];
  return names.length === 1 && sourceFunctionShape(node, SUM, reserved, [[names[0], "roundValue"]])
    ? { roundingFunction: names[0] } : undefined;
}

// Capture only literal schema identities/discriminators at exact AST positions.
// The complete loop, guards, reads, counter write, output and return must match;
// a familiar function name or a partial effect list is never sufficient.
export function sourceFilteredDetailAggregate(node, reserved) {
  const copy = structuredClone(node), captures = new Map(), calls = [];
  const capture = (actual, expected) => {
    if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object") return;
    if (expected.type === "Literal" && /^__\w+__$/.test(expected.value)) {
      if (actual.type !== "Literal" || typeof actual.value !== "string" || actual.regex ||
          captures.has(expected.value) && captures.get(expected.value) !== actual.value) return;
      captures.set(expected.value, actual.value); actual.value = expected.value;
    }
    for (const key of Object.keys(expected)) if (key !== "raw") {
      if (Array.isArray(expected[key])) expected[key].forEach((child, i) => capture(actual[key]?.[i], child));
      else if (expected[key] && typeof expected[key] === "object") capture(actual[key], expected[key]);
    }
  };
  capture(copy, FILTERED);
  walk(copy?.body, item => { if (item.type === "CallExpression" && item.callee.type === "Identifier" &&
    !["$", "Number", "SetXFormFieldValueById"].includes(item.callee.name)) calls.push(item.callee.name); });
  const names = [...new Set(calls)];
  if (names.length !== 1 || captures.size !== 8 ||
      !sourceFunctionShape(copy, FILTERED, reserved, [[names[0], "roundValue"]])) return undefined;
  return { roundingFunction: names[0], radioColumnId: captures.get("__radio__"), counterId: captures.get("__counter__") };
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) if (value && typeof value === "object")
    Array.isArray(value) ? value.forEach(child => walk(child, visit)) : walk(value, visit);
}
