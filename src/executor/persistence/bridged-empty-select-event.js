import { bridgedEmptySelectEventFunction } from "../../dsl/bridged-row-visibility.js";

// The source event represents a cleared single select as ""; NewOA dispatches
// null. Keep the source DSL unchanged and adapt only independently proven row
// owners in the native projection.
export function withBridgedEmptySelectEvents(scripts = {}, form = {}, formRules = {}) {
  const metadata = formRules?.review?.bridgedInitialVisibility;
  if (!metadata) return scripts;
  const entries = Array.isArray(metadata.entries) ? metadata.entries : [];
  const ids = new Set(entries.map(entry => entry?.changeActionId));
  const actions = Array.isArray(scripts?.actions) ? scripts.actions : [];
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const adapted = actions.map(action => {
    if (!ids.has(action?.id)) return action;
    const selector = fields.filter(field => field?.id === action.controlId);
    if (selector.length !== 1) throw new Error("Bridged row owner has no unique selector.");
    if (selector[0].type !== "singleSelect") return action;
    const fn = bridgedEmptySelectEventFunction(action, form);
    if (!fn) throw new Error("Bridged row owner has no source-backed empty select event.");
    return { ...action, function: fn };
  });
  return { ...scripts, actions: adapted };
}
