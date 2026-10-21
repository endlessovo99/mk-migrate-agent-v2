import { parse } from "acorn";

const key = node => JSON.stringify(node, (name, value) => ["start", "end", "raw"].includes(name) ? undefined : value);
const body = node => node?.type === "BlockStatement" ? node.body.filter(node => node.type !== "EmptyStatement") : [];

// Source-only effect proof. This intentionally retains the source's missing
// timer argument: zero or repeated callbacks can still affect only one fixed
// table descendant. It does not repair timing or approve a runtime policy.
export function sourceTablePollEffect(node) {
  if (node?.type !== "FunctionDeclaration" || node.async || node.generator || node.params.length !== 1 || node.params[0].type !== "Identifier") return undefined;
  const statements = body(node.body), variable = statements[0]?.declarations?.[0], branch = statements[1];
  const local = variable?.id?.type === "Identifier" && variable.id.name, parameter = node.params[0].name;
  const timer = body(branch?.consequent)[0]?.expression, remove = body(branch?.alternate)[0]?.expression;
  const selector = remove?.callee?.object?.callee?.object?.arguments?.[0]?.value;
  const tableId = typeof selector === "string" && /^#TABLE_DL_([A-Za-z_][\w]*) > tbody > tr$/.exec(selector)?.[1];
  const delay = timer?.arguments?.[1]?.value;
  if (!local || !tableId || !Number.isInteger(delay) || delay < 0 || delay > 2147483647 ||
      new Set([local, parameter, node.id.name]).size !== 3 || [local, parameter, node.id.name].some(name => ["document", "$", "setTimeout", "window", "globalThis", "eval", "Function"].includes(name))) return undefined;
  const expected = parse(`function ${node.id.name}(${parameter}){var ${local}=document.getElementById("TABLE_DL_"+${parameter});if(!${local}){setTimeout(${node.id.name},${delay});}else{$(${JSON.stringify(selector)}).eq(1).remove();}}`, { ecmaVersion: "latest" }).body[0];
  return key(node) === key(expected) ? { tableId, delay, parameterTransport: "source-no-argument-delayed-callback" } : undefined;
}
