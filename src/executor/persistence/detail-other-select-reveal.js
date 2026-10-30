import { createHash } from "node:crypto";

/** Display-only action for independently stored, source-bound detail fields. */
export function detailOtherSelectAction(specs) {
  const valid = id => typeof id === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(id);
  if (!Array.isArray(specs) || !specs.length || specs.some(item => !valid(item.tableId) || !valid(item.choiceId) || !valid(item.textId) ||
      item.choiceId === item.textId || typeof item.optionValue !== "string" || !item.optionValue) ||
      new Set(specs.map(item => `${item.tableId}.${item.textId}`)).size !== specs.length) throw invalid();
  const items = specs.map(({ tableId, choiceId, textId, optionValue }) => ({ tableId, choiceId, textId, optionValue }));
  const css = items.flatMap(item => {
    const root = `#${item.tableId}`, note = `${item.tableId}.${item.textId}~`;
    return [
      `${root} td:not(:has(> div > div[style*="color: rgb(255, 68, 68)"])) [data-name^="${note}"][data-mk-detail-other="closed"] input:not([readonly]):not(:disabled),`,
      `${root} td:not(:has(> div > div[style*="color: rgb(255, 68, 68)"])) [data-name^="${note}"][data-mk-detail-other="closed"] textarea:not([readonly]):not(:disabled) { display: none !important; }`,
      `${root} [data-id^="${note}"][data-mk-detail-other="closed"]:has(input:not([readonly]):not(:disabled),textarea:not([readonly]):not(:disabled)):not(:has(.ele-xform-fieldset-label-required,.ele-xform-fieldset-required,.required,input[readonly],input:disabled,textarea[readonly],textarea:disabled)) { display: none !important; }`
    ];
  }).join("\n");
  const styleId = `mk-detail-other-${createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 16)}`;
  return { id: "mk-choice-other-detail-select-v1", name: "onLoadDetailOtherSelect", event: "onLoad", scope: "global", translationStatus: "mapped",
    function: `function onLoadDetailOtherSelect(context) {
  if (typeof document === "undefined" || !document || !document.head || !document.documentElement ||
      typeof MutationObserver !== "function" || typeof MKXFORM === "undefined" || !MKXFORM || !MKXFORM.MKXFORM_DATA_CONTAINER ||
      !MKXFORM.$$FORM || !MKXFORM.$$FORM.current || typeof MKXFORM.getValue !== "function" ||
      typeof MKXFORM.onChange !== "function" || typeof MKXFORM.$ !== "function") return;
  var container = MKXFORM.MKXFORM_DATA_CONTAINER, nativeForm = MKXFORM.$$FORM.current;
  var previous = container.__mkDetailOtherSelectV1;
  if (previous && previous.nativeForm === nativeForm) return;
  if (previous && previous.observer) previous.observer.disconnect();
  var css = ${JSON.stringify(css)}, styleId = ${JSON.stringify(styleId)}, style = document.getElementById(styleId);
  if (style && style.textContent !== css) return;
  if (!style) { style = document.createElement("style"); style.id = styleId; style.textContent = css; document.head.appendChild(style); }
  var state = { nativeForm: nativeForm, items: ${JSON.stringify(items)}, observer: null, scheduled: false };
  container.__mkDetailOtherSelectV1 = state;
  function current() { return typeof MKXFORM !== "undefined" && MKXFORM && MKXFORM.$$FORM && MKXFORM.$$FORM.current === nativeForm; }
  function notes(root, item) {
    var prefix = item.tableId + "." + item.textId + "~";
    return Array.prototype.slice.call(root.querySelectorAll('[data-name^="' + prefix + '"], [data-id^="' + prefix + '"]'));
  }
  function clear(root, item) { if (root) notes(root, item).forEach(function(node) { node.removeAttribute("data-mk-detail-other"); }); }
  function refresh(item) {
    var root = document.getElementById(item.tableId);
    if (!root || !current()) return;
    try {
      var nodes = notes(root, item), value = MKXFORM.getValue(item.tableId), rows = Array.isArray(value) ? value : value && value.values;
      var accessor = MKXFORM.$(item.tableId), self = accessor && accessor.getSelf && accessor.getSelf(), columns = self && self.props && self.props.columns;
      var matching = Array.isArray(columns) ? columns.filter(function(column) { return column.controlProps && column.controlProps.name === item.textId; }) : [];
      var rules = matching.length === 1 && matching[0].options && matching[0].options.validateRules;
      if (!Array.isArray(rows) || !Array.isArray(rules) || ["add", "edit"].indexOf(MKXFORM.viewStatus) < 0) { clear(root, item); return; }
      var required = rules.some(function(rule) { return rule && rule.required === true; }), byKey = new Map();
      rows.forEach(function(row) { if (!row || (typeof row.key !== "string" && typeof row.key !== "number")) return;
        var key = String(row.key); byKey.set(key, byKey.has(key) ? null : row); });
      var notePrefix = item.tableId + "." + item.textId + "~", choicePrefix = item.tableId + "." + item.choiceId + "~";
      var choices = Array.prototype.slice.call(root.querySelectorAll('[data-name^="' + choicePrefix + '"], [data-id^="' + choicePrefix + '"]'));
      nodes.forEach(function(node) {
        var desktop = node.hasAttribute("data-name"), address = node.getAttribute(desktop ? "data-name" : "data-id"), key = address.slice(notePrefix.length), row = byKey.get(key);
        var matches = choices.filter(function(choice) { return choice.getAttribute(desktop ? "data-name" : "data-id") === choicePrefix + key; });
        var select = matches.length === 1 && matches[0].querySelector(desktop ? ".lui-select" : ".mui-select");
        var input = node.querySelector('input:not([type="hidden"]), textarea'), value = row && row[item.choiceId], cell = desktop && node.closest("td");
        var star = desktop ? cell && Array.prototype.some.call(cell.querySelectorAll("div"), function(div) { return div.textContent.trim() === "*" && div.style.color === "rgb(255, 68, 68)"; }) :
          node.querySelector(".ele-xform-fieldset-label-required, .ele-xform-fieldset-required, .required");
        if (!row || !select || select.classList.contains("lui-select-disabled") || select.classList.contains("mui-select-disabled") ||
            select.getAttribute("aria-disabled") === "true" || select.querySelector('[disabled], [aria-disabled="true"]') ||
            !input || input.disabled || input.readOnly || required || star || (desktop && !cell) ||
            !(value === null || value === undefined || typeof value === "string")) {
          node.removeAttribute("data-mk-detail-other"); return;
        }
        var desired = value === item.optionValue ? "open" : "closed";
        if (node.getAttribute("data-mk-detail-other") !== desired) node.setAttribute("data-mk-detail-other", desired);
      });
    } catch (_) { clear(root, item); }
  }
  function refreshAll() { if (current()) state.items.forEach(refresh); }
  function schedule() {
    if (!current() || state.scheduled) return;
    state.scheduled = true;
    var run = function() { state.scheduled = false; refreshAll(); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run); else setTimeout(run, 0);
  }
  try {
    Array.from(new Set(state.items.map(function(item) { return item.tableId; }))).forEach(function(table) { MKXFORM.onChange(table, schedule); });
  } catch (_) {
    state.items.forEach(function(item) { clear(document.getElementById(item.tableId), item); });
    delete container.__mkDetailOtherSelectV1;
    return;
  }
  state.observer = new MutationObserver(function(changes) {
    if (!current()) { state.observer.disconnect(); return; }
    if (changes.some(function(change) { return state.items.some(function(item) {
      var root = document.getElementById(item.tableId);
      if (root && (root === change.target || root.contains(change.target))) return true;
      return Array.prototype.some.call(change.addedNodes || [], function(node) { return node.nodeType === 1 && (node.id === item.tableId || node.querySelector && node.querySelector('#' + item.tableId)); });
    }); })) schedule();
  });
  state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["disabled", "readonly", "aria-disabled", "class", "style"] });
  refreshAll();
}` };
}
function invalid() { const error = new Error("Detail Other select binding is invalid."); error.code = "projection.detail_other_select_invalid"; return error; }
