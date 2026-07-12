export const BEFORE_SUBMIT_DISPATCH_STRATEGY = "ordered_await_false_short_circuit";
export const ORDERED_DISPATCH_STRATEGY = "ordered";

export function singletonDispatcherContract(event, actions = []) {
  const childNames = actions.map((_, index) => `${event}_${index + 1}`);
  return {
    event,
    actionIds: actions.map((action) => action.id),
    childNames,
    callNames: [...childNames],
    strategy: event === "onBeforeSubmit"
      ? BEFORE_SUBMIT_DISPATCH_STRATEGY
      : ORDERED_DISPATCH_STRATEGY
  };
}

export function dispatcherActionStartMarker(name) {
  return `/* mk-migrate:action-start=${name} */`;
}

export function dispatcherActionEndMarker(name) {
  return `/* mk-migrate:action-end=${name} */`;
}

export function dispatcherCallStartMarker(name) {
  return `/* mk-migrate:call-start=${name} */`;
}

export function dispatcherCallEndMarker(name) {
  return `/* mk-migrate:call-end=${name} */`;
}

export function renderDispatcherInvocation(event, childNames) {
  const blocks = childNames.map((name) => {
    const statement = event === "onBeforeSubmit"
      ? `if (await ${name}(context) === false) return false;`
      : `${name}(context);`;
    return [
      `  ${dispatcherCallStartMarker(name)}`,
      `  ${statement}`,
      `  ${dispatcherCallEndMarker(name)}`
    ].join("\n");
  });
  if (event === "onBeforeSubmit") blocks.push("  return true;");
  return blocks.join("\n");
}

export function markedDispatcherActionFunction(source, name) {
  if (!name) return "";
  const startMarker = dispatcherActionStartMarker(name);
  const endMarker = dispatcherActionEndMarker(name);
  const start = String(source || "").indexOf(startMarker);
  if (start < 0) return "";
  const contentStart = start + startMarker.length;
  const end = String(source || "").indexOf(endMarker, contentStart);
  if (end < 0) return "";
  const functionText = String(source || "").slice(contentStart, end).trim();
  const declaration = new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\s*\\(`);
  return declaration.test(functionText) ? functionText : "";
}

export function dispatcherCallNames(source) {
  return [...String(source || "").matchAll(/\/\*\s*mk-migrate:call-start=([^*]+?)\s*\*\//g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
