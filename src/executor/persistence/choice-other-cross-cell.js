import { createHash } from "node:crypto";
import { choiceOtherRevealBindings } from "../../dsl/choice-other-reveal.js";

/** Fixed display-only runtime for an explicitly source-bound adjacent-cell pair. */
export function withCrossCellOtherReveal(scripts = {}, form = {}, mainTableName) {
  const bindings = choiceOtherRevealBindings(form).filter(binding => binding.crossCell === true);
  if (!bindings.length) return scripts;
  const valid = value => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(value);
  if (!valid(mainTableName) || bindings.some(binding => !valid(binding.triggerId) || !valid(binding.textId))) throw invalid();
  const specs = bindings.map(binding => ({ trigger: `${mainTableName}.${binding.triggerId}`,
    text: `${mainTableName}.${binding.textId}`, selected: binding.optionValue }));
  const css = specs.map(item => `[data-id="${item.text}"][data-mk-cross-other="closed"]:not(:has(.ele-xform-fieldset-required, input[readonly], input:disabled, textarea[readonly], textarea:disabled)) { display: none !important; }`).join("\n");
  const styleId = `mk-cross-other-${createHash("sha256").update(JSON.stringify(specs)).digest("hex").slice(0, 16)}`;
  const action = { id: "mk-choice-other-cross-cell-v1", name: "onLoadCrossCellOther", event: "onLoad", scope: "global", translationStatus: "mapped",
    function: `function onLoadCrossCellOther(context) {
  if (typeof document === "undefined" || !document || !document.head || typeof document.querySelectorAll !== "function") return;
  if (typeof MKXFORM === "undefined" || !MKXFORM || !MKXFORM.MKXFORM_DATA_CONTAINER || !MKXFORM.$$FORM || !MKXFORM.$$FORM.current ||
      typeof MKXFORM.getValue !== "function" || typeof MKXFORM.getFieldAttr !== "function" || typeof MKXFORM.onChange !== "function") return;
  var nativeForm = MKXFORM.$$FORM.current, container = MKXFORM.MKXFORM_DATA_CONTAINER;
  var previous = container.__mkCrossCellOtherV1;
  if (previous && previous.nativeForm === nativeForm) return;
  if (previous && previous.observer) previous.observer.disconnect();
  var css = ${JSON.stringify(css)}, styleId = ${JSON.stringify(styleId)}, style = document.getElementById(styleId);
  if (style && style.textContent !== css) return;
  if (!style) { style = document.createElement("style"); style.id = styleId; style.textContent = css; document.head.appendChild(style); }
  var state = { nativeForm: nativeForm, observer: null, items: ${JSON.stringify(specs)} };
  container.__mkCrossCellOtherV1 = state;
  function current() { return MKXFORM && MKXFORM.$$FORM && MKXFORM.$$FORM.current === nativeForm; }
  function refresh(item) {
    if (!current()) return;
    var notes = document.querySelectorAll('[data-id="' + item.text + '"]');
    var triggers = document.querySelectorAll('[data-id="' + item.trigger + '"]');
    if (notes.length !== 1 || triggers.length !== 1) {
      Array.prototype.forEach.call(notes, function(node) { node.removeAttribute("data-mk-cross-other"); }); return;
    }
    var checkbox = triggers[0].querySelector('input[type="checkbox"]');
    var note = notes[0].querySelector('input:not([type="hidden"]), textarea');
    var value, text, attr, selected;
    try { attr = MKXFORM.getFieldAttr(item.text); value = MKXFORM.getValue(item.trigger); text = MKXFORM.getValue(item.text); }
    catch (_) { notes[0].removeAttribute("data-mk-cross-other"); return; }
    // The native API observes validation rules even when the input DOM has no
    // required attribute. Unknown, required, hidden and readonly states fail open.
    if (!checkbox || checkbox.disabled || checkbox.readOnly || !note || note.disabled || note.readOnly || attr !== 2) {
      notes[0].removeAttribute("data-mk-cross-other"); return;
    }
    if (Array.isArray(value) && value.length <= 1 && value.every(function(v) { return v === item.selected; })) selected = value.length === 1;
    else if (value === null || value === undefined || value === "") selected = false;
    else if (value === item.selected) selected = true;
    else { notes[0].removeAttribute("data-mk-cross-other"); return; }
    if (item.checkbox !== checkbox && typeof checkbox.addEventListener === "function") {
      item.checkbox = checkbox;
      checkbox.addEventListener("change", function(event) {
        if (event && event.isTrusted) item.touched = true;
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(function() { if (current()) refresh(item); });
      });
    }
    // Existing records may predate the generated checkbox. Until the user
    // changes it, never hide a retained explanation behind an empty default.
    if (!selected && !item.touched && text !== undefined && text !== null && text !== "") {
      notes[0].removeAttribute("data-mk-cross-other"); return;
    }
    notes[0].setAttribute("data-mk-cross-other", selected ? "open" : "closed");
  }
  state.items.forEach(function(item) {
    MKXFORM.onChange(item.trigger, function() { if (!current()) return; refresh(item);
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(function() { if (current()) refresh(item); }); });
    refresh(item);
  });
  if (typeof MutationObserver === "function" && document.documentElement) {
    state.observer = new MutationObserver(function() { if (!current()) { state.observer.disconnect(); return; } state.items.forEach(refresh); });
    state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["disabled", "readonly", "class"] });
  }
}` };
  const actions = Array.isArray(scripts.actions) ? scripts.actions : [];
  const existing = actions.filter(item => item.id === action.id);
  if (existing.length) {
    if (existing.length === 1 && Object.keys(existing[0]).length === Object.keys(action).length &&
        Object.keys(action).every(key => existing[0][key] === action[key])) return scripts;
    throw invalid();
  }
  return { ...scripts, actions: [...actions, action] };
}
function invalid() { const error = new Error("Cross-cell Other presentation is not uniquely projected."); error.code = "projection.choice_other_cross_cell_invalid"; return error; }
