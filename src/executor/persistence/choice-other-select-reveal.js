import { choiceOtherRevealBindings } from "../../dsl/choice-other-reveal.js";
import { usesAdaptiveLayout } from "../../dsl/layout-sizing.js";
import { effectiveCellFlow } from "./adaptive-layout.js";
import { choiceOtherFlowGroups, choiceOtherGroupScope } from "./choice-other-layout.js";

/** Project a display-only listener; it never writes the source choice or note. */
export function withChoiceOtherSelectReveal(scripts = {}, form = {}, mainTableName) {
  const bindings = choiceOtherRevealBindings(form).filter(binding =>
    form.fields.find(field => field.id === binding.choiceId)?.componentId === "xform-select");
  if (!bindings.length) return scripts;
  if (typeof mainTableName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(mainTableName)) throw invalid("main table");
  const groups = [];
  const visit = node => {
    if (!node || typeof node !== "object") return;
    const flow = effectiveCellFlow(node, usesAdaptiveLayout(form));
    if (flow) groups.push(...choiceOtherFlowGroups(flow, form.fields).filter(group => group.mode === "select" && group.revealOnSelection));
    for (const child of node.children || []) visit(child);
  };
  for (const row of form.layout?.mkTree || []) visit(row);
  const specs = bindings.map(binding => {
    const matches = groups.filter(group => group.referenceIds[0] === binding.triggerId && group.referenceIds[1] === binding.textId);
    if (matches.length !== 1) throw invalid(binding.choiceId);
    return { scope: choiceOtherGroupScope(matches[0]), ref: `${mainTableName}.${binding.choiceId}`, other: binding.optionValue };
  });
  const action = {
    id: "mk-choice-other-select-reveal-v1", name: "onLoadChoiceOtherSelectReveal", event: "onLoad", scope: "global", translationStatus: "mapped",
    function: `function onLoadChoiceOtherSelectReveal(context) {
  if (typeof document === "undefined" || !document || typeof document.querySelectorAll !== "function") return;
  if (typeof MKXFORM === "undefined" || !MKXFORM || !MKXFORM.MKXFORM_DATA_CONTAINER ||
      !MKXFORM.$$FORM || !MKXFORM.$$FORM.current || typeof MKXFORM.getValue !== "function" || typeof MKXFORM.onChange !== "function") {
    throw new Error("Other select presentation requires a ready native form and value/subscription APIs.");
  }
  var container = MKXFORM.MKXFORM_DATA_CONTAINER, nativeForm = MKXFORM.$$FORM.current;
  var previous = container.__mkMigrationOtherSelectRevealV1;
  if (previous && previous.nativeForm === nativeForm) return;
  if (previous && previous.observer) previous.observer.disconnect();
  var state = { nativeForm: nativeForm, observer: null, items: ${JSON.stringify(specs)} };
  container.__mkMigrationOtherSelectRevealV1 = state;
  function current() { return typeof MKXFORM !== "undefined" && MKXFORM && MKXFORM.$$FORM && MKXFORM.$$FORM.current === nativeForm; }
  function refresh(item) {
    if (!current()) return true;
    var nodes = document.querySelectorAll("." + item.scope);
    if (nodes.length !== 1) {
      Array.prototype.forEach.call(nodes, function(node) { node.removeAttribute("data-mk-other-state"); });
      return nodes.length > 1;
    }
    var choice = nodes[0].querySelector(".mk-choice-other-choice");
    var control = choice && choice.querySelector('select, [role="combobox"]');
    if (!control || control.disabled || control.getAttribute("aria-disabled") === "true" ||
        choice.querySelector(".lui-select-disabled, .mui-select-disabled") ||
        (item.value !== undefined && item.value !== null && typeof item.value !== "string")) {
      nodes[0].removeAttribute("data-mk-other-state");
    } else {
      nodes[0].setAttribute("data-mk-other-state", item.value === item.other ? "open" : "closed");
    }
    return true;
  }
  function watchGroups() {
    if (state.observer || typeof MutationObserver !== "function" || !document.documentElement) return;
    state.observer = new MutationObserver(function(changes) {
      if (!current()) { if (state.observer) state.observer.disconnect(); state.observer = null; return; }
      var relevant = changes.some(function(change) {
        return state.items.some(function(item) {
          return change.target && typeof change.target.closest === "function" && change.target.closest("." + item.scope);
        }) || Array.prototype.some.call(change.addedNodes || [], matchesGroup) ||
          Array.prototype.some.call(change.removedNodes || [], matchesGroup);
      });
      if (relevant) state.items.forEach(function(item) { item.value = MKXFORM.getValue(item.ref); refresh(item); });
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true,
      attributes: true, attributeFilter: ["disabled", "aria-disabled", "class"] });
  }
  function matchesGroup(node) {
    if (!node || (node.nodeType !== 1 && node.nodeType !== 11)) return false;
    return state.items.some(function(item) {
      var selector = "." + item.scope;
      return (typeof node.matches === "function" && node.matches(selector)) ||
        (typeof node.querySelector === "function" && node.querySelector(selector));
    });
  }
  state.items.forEach(function(item) {
    item.value = MKXFORM.getValue(item.ref);
    MKXFORM.onChange(item.ref, function(value) {
      if (!current()) return;
      item.value = value;
      refresh(item);
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(function() {
        if (current()) refresh(item);
      });
    });
    refresh(item);
  });
  watchGroups();
}`
  };
  const actions = Array.isArray(scripts.actions) ? scripts.actions : [];
  const occupied = actions.filter(item => item.id === action.id);
  if (occupied.length) {
    if (occupied.length === 1 && Object.keys(occupied[0]).length === Object.keys(action).length &&
        Object.keys(action).every(key => occupied[0][key] === action[key])) return scripts;
    throw invalid("action identity");
  }
  return { ...scripts, actions: [...actions, action] };
}

function invalid(detail) {
  const error = new Error(`Other select presentation is not uniquely projected: ${detail}.`);
  error.code = "projection.choice_other_select_reveal_invalid";
  return error;
}
