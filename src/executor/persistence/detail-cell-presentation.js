import { createHash } from "node:crypto";
import { adaptiveStyles } from "./adaptive-layout.js";

const ACTION_ID = "mk-detail-cell-presentation-v1";
const identifier = value => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,24}$/.test(value);

/** Fixed, presentation-only native runtime. Field values and writers are untouched. */
export function withDetailCellPresentation(scripts = {}, form = {}, mainTableName) {
  const tables = (form.fields || []).filter(field => field?.type === "detailTable" && field.detailCellGroups?.length);
  if (!tables.length) return scripts;
  if (form.layout?.sizing !== "adaptive" || typeof mainTableName !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(mainTableName)) throw invalid();
  const specs = [];
  for (const table of tables) {
    if (!identifier(table.id) || !Array.isArray(table.columns) || !Array.isArray(table.detailCellGroups)) throw invalid();
    for (const group of table.detailCellGroups) {
      const ids = group?.fieldIds;
      if (group?.version !== 1 || !Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1] || !ids.every(identifier) ||
          ids.some(id => table.columns.filter(column => column?.id === id && column.dataOnly !== true).length !== 1)) throw invalid();
      const key = createHash("sha256").update(JSON.stringify([mainTableName, table.id, ids])).digest("hex").slice(0, 16);
      specs.push({ table: table.id, first: ids[0], second: ids[1], key });
    }
  }
  const members = specs.flatMap(item => [`${item.table}:${item.first}`, `${item.table}:${item.second}`]);
  if (new Set(members).size !== members.length) throw invalid();
  const scope = adaptiveStyles(mainTableName).scope;
  const css = detailCellPresentationCss(scope, specs);
  const styleId = `mk-detail-cell-${createHash("sha256").update(JSON.stringify([scope, specs])).digest("hex").slice(0, 20)}`;
  const body = `function onLoadDetailCellPresentation(context) {\n  (${installDetailCellPresentation.toString()})(${JSON.stringify(specs)}, ${JSON.stringify(scope)}, ${JSON.stringify(css)}, ${JSON.stringify(styleId)});\n}`;
  const common = { name: "onLoadDetailCellPresentation", event: "onLoad", translationStatus: "mapped", function: body };
  // The native designer preview deliberately suppresses global onLoad. Its
  // detail-table onLoad still runs, so install the same idempotent presenter
  // there as well as on the normal form lifecycle.
  const generated = [
    { id: ACTION_ID, ...common, scope: "global" },
    ...tables.map(table => ({ id: `${ACTION_ID}.${table.id}`, ...common, scope: "control", tableId: table.id, controlId: table.id }))
  ];
  const actions = Array.isArray(scripts.actions) ? scripts.actions : [];
  const missing = [];
  for (const action of generated) {
    const existing = actions.filter(item => item.id === action.id);
    if (!existing.length) missing.push(action);
    else if (existing.length !== 1 || Object.keys(existing[0]).length !== Object.keys(action).length ||
        !Object.keys(action).every(key => existing[0][key] === action[key])) throw invalid();
  }
  return missing.length ? { ...scripts, actions: [...actions, ...missing] } : scripts;
}

export function detailCellPresentationCss(scope, specs) {
  const clip = "position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important";
  return specs.map(item => {
    const root = `.${scope} ~ * [data-id="${item.table}"]`, start = `[data-mk-detail-cell="${item.key}-start"]`, end = `[data-mk-detail-cell="${item.key}-end"]`;
    const requiredEnd = `[data-mk-detail-cell="${item.key}-end-required"]`, optionalEnd = `[data-mk-detail-cell="${item.key}-end-optional"]`;
    return [
      `${root} th${start}{border-right-color:transparent!important}`,
      `${root} th${start}::before{background:transparent!important}`,
      `${root} th${end}>span:first-child>span[title]{${clip}}`,
      `${root} td[data-mk-detail-cell="${item.key}-body-start"]{border-right-color:transparent!important}`,
      `${root} .ele-xform-m-detail-table ${start}::after{content:none!important}`,
      `${root} .ele-xform-m-detail-table ${requiredEnd} .ele-xform-fieldset-label-title-align,${root} .ele-xform-m-detail-table ${optionalEnd} .ele-xform-fieldset-label-title-align{${clip}}`,
      `${root} .ele-xform-m-detail-table ${optionalEnd} .ele-xform-fieldset-label-wrap{height:0!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important}`
    ].join("\n");
  }).join("\n");
}

// Serialized verbatim into a native onLoad action. It adds only scoped DOM
// attributes and a fixed stylesheet; it never writes form fields or row data.
function installDetailCellPresentation(specs, scope, css, styleId) {
  if (typeof document === "undefined" || !document.head || !document.documentElement ||
      typeof window === "undefined" || typeof Array.from !== "function" || typeof Array.prototype.findIndex !== "function" ||
      typeof MutationObserver !== "function" || typeof MKXFORM === "undefined" || !MKXFORM ||
      !MKXFORM.MKXFORM_DATA_CONTAINER || !MKXFORM.$$FORM || !MKXFORM.$$FORM.current || typeof MKXFORM.$ !== "function") return;
  var container = MKXFORM.MKXFORM_DATA_CONTAINER, nativeForm = MKXFORM.$$FORM.current;
  var previous = container.__mkDetailCellPresentationV1;
  if (previous && previous.kind !== "mk-detail-cell-presentation-v1") return;
  if (previous && !previous.disposed && previous.nativeForm === nativeForm && previous.styleId === styleId &&
      previous.style && previous.style.textContent === css && typeof previous.refresh === "function") { previous.refresh(); return; }
  if (previous && typeof previous.dispose === "function") previous.dispose();
  var style = document.getElementById(styleId);
  if (style && style.textContent !== css) return;
  if (!style) { style = document.createElement("style"); style.id = styleId; style.textContent = css; document.head.appendChild(style); }
  var state = { kind: "mk-detail-cell-presentation-v1", nativeForm: nativeForm, styleId: styleId, style: style, marked: [], observer: null, pending: false, disposed: false };
  var owned = Object.create(null), tables = Object.create(null), selectors = [];
  specs.forEach(function(spec) { ["-start", "-end", "-body-start", "-end-required", "-end-optional"].forEach(function(suffix) { owned[spec.key + suffix] = true; });
    if (!tables[spec.table]) { tables[spec.table] = true; selectors.push('.' + scope + ' ~ * [data-id="' + spec.table + '"] [data-mk-detail-cell]'); } });
  var markedSelector = selectors.join(",");
  container.__mkDetailCellPresentationV1 = state;
  function current() { return !state.disposed && typeof MKXFORM !== "undefined" && MKXFORM && MKXFORM.$$FORM && MKXFORM.$$FORM.current === nativeForm; }
  function clear() {
    state.marked.forEach(function(item) { if (item.node.getAttribute("data-mk-detail-cell") === item.value) item.node.removeAttribute("data-mk-detail-cell"); });
    state.marked = [];
    // A native clone can copy DOM attributes without going through mark().
    // Clear only our exact group tokens within this form before recomputing.
    if (markedSelector) Array.prototype.forEach.call(document.querySelectorAll(markedSelector), function(node) {
      if (owned[node.getAttribute("data-mk-detail-cell")]) node.removeAttribute("data-mk-detail-cell");
    });
  }
  function mark(node, value) { if (!node || node.hasAttribute("data-mk-detail-cell")) return false; node.setAttribute("data-mk-detail-cell", value); state.marked.push({ node: node, value: value }); return true; }
  function labelsForDesktop(root, table) {
    var tables = root.querySelectorAll(".ele-xform-detail-table-table table"), self, props;
    if (tables.length !== 1 || !tables[0].tHead || tables[0].tHead.rows.length !== 1) return null;
    try { self = MKXFORM.$(table).getSelf(); props = self && self.props; } catch (_) { return null; }
    if (!props || !Array.isArray(props.columns) || props.columns.length > 64) return null;
    var headers = Array.prototype.filter.call(tables[0].tHead.rows[0].cells, function(node) {
      return !node.classList.contains("lui-table-selection-column") && !node.classList.contains("lui-pro-table-cell-serial") && !node.classList.contains("lui-pro-table-cell-operations");
    });
    var columns = props.columns.filter(function(column) {
      var name = column && column.controlProps && column.controlProps.name;
      return name && column.type !== "@elem/xform-hidden" && !column.controlProps.hidden &&
        !(props.extraAuth && props.extraAuth[name] && props.extraAuth[name].visible === false) &&
        !(props.authFields && props.authFields.fields && props.authFields.fields[name] && props.authFields.fields[name].visible === false);
    });
    if (columns.some(function(column) { return column.children && column.children.length || typeof column.label !== "string"; })) return null;
    var labels = headers.map(function(node) { var titles = node.querySelectorAll("span[title]"); return titles.length === 1 ? titles[0].getAttribute("title") : null; });
    if (labels.some(function(label) { return typeof label !== "string"; })) return null;
    var m = labels.length, n = columns.length, forward = [], backward = [], i, j;
    if (m > 64 || n > 64) return null;
    for (i = 0; i <= m; i++) { forward[i] = []; backward[i] = []; for (j = 0; j <= n; j++) { forward[i][j] = false; backward[i][j] = false; } }
    for (j = 0; j <= n; j++) { forward[0][j] = true; backward[m][j] = true; }
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++) forward[i][j] = forward[i][j - 1] || forward[i - 1][j - 1] && labels[i - 1] === columns[j - 1].label;
    if (!forward[m][n]) return null;
    for (i = m - 1; i >= 0; i--) for (j = n - 1; j >= 0; j--) backward[i][j] = backward[i][j + 1] || backward[i + 1][j + 1] && labels[i] === columns[j].label;
    var possible = labels.map(function(label, row) { var ids = []; for (var index = 0; index < n; index++) if (forward[row][index] && label === columns[index].label && backward[row + 1][index + 1]) ids.push(columns[index].controlProps.name); return ids; });
    return { headers: headers, possible: possible, table: tables[0] };
  }
  function visible(node, parent) {
    if (!node || !node.getClientRects || !node.getClientRects().length) return false;
    for (var item = node; item && item !== parent; item = item.parentElement) {
      var style = window.getComputedStyle(item);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    return true;
  }
  function mobile(root, spec) {
    var contents = root.querySelectorAll(".ele-xform-m-detail-table-content-simple .row .content");
    Array.prototype.forEach.call(contents, function(content) {
      var children = Array.prototype.slice.call(content.children), a = [], b = [];
      children.forEach(function(node, index) { var id = node.getAttribute("data-id") || ""; if (id.indexOf(spec.table + "." + spec.first + "~") === 0) a.push({ node: node, index: index, key: id.slice((spec.table + "." + spec.first + "~").length) }); if (id.indexOf(spec.table + "." + spec.second + "~") === 0) b.push({ node: node, index: index, key: id.slice((spec.table + "." + spec.second + "~").length) }); });
      if (a.length !== 1 || b.length !== 1 || !a[0].key || a[0].key !== b[0].key || b[0].index <= a[0].index ||
          !visible(a[0].node, content) || !visible(b[0].node, content)) return;
      var between = children.slice(a[0].index + 1, b[0].index);
      if (between.length > 1 || between.some(function(node) { return !node.classList.contains("hidden") || node.hasAttribute("data-id") || window.getComputedStyle(node).display !== "none"; })) return;
      if (a[0].node.hasAttribute("data-mk-detail-cell") || b[0].node.hasAttribute("data-mk-detail-cell")) return;
      var required = b[0].node.querySelector(".ele-xform-fieldset-label-required");
      mark(a[0].node, spec.key + "-start"); mark(b[0].node, spec.key + (required && visible(required, b[0].node) ? "-end-required" : "-end-optional"));
    });
  }
  function desktopRows(mapped, spec) {
    Array.prototype.forEach.call(mapped.table.tBodies || [], function(body) {
      Array.prototype.forEach.call(body.rows || [], function(row) {
        var first = row.querySelectorAll('[data-name^="' + spec.table + '.' + spec.first + '~"]');
        var second = row.querySelectorAll('[data-name^="' + spec.table + '.' + spec.second + '~"]');
        if (first.length !== 1 || second.length !== 1 || !visible(first[0], row) || !visible(second[0], row)) return;
        var a = first[0].closest("td"), b = second[0].closest("td");
        var firstKey = first[0].getAttribute("data-name").slice((spec.table + "." + spec.first + "~").length);
        var secondKey = second[0].getAttribute("data-name").slice((spec.table + "." + spec.second + "~").length);
        if (!a || !b || a.parentElement !== row || b.parentElement !== row || a.nextElementSibling !== b || !firstKey || firstKey !== secondKey) return;
        mark(a, spec.key + "-body-start");
      });
    });
  }
  function refresh() {
    state.pending = false;
    if (!current()) { state.dispose(); return; }
    clear();
    var marker = document.querySelectorAll("." + scope);
    if (marker.length !== 1 || !marker[0].parentElement) return;
    var cache = {};
    specs.forEach(function(spec) {
      if (!Object.prototype.hasOwnProperty.call(cache, spec.table)) {
        var roots = document.querySelectorAll('.' + scope + ' ~ * [data-id="' + spec.table + '"]');
        cache[spec.table] = roots.length === 1 ? { root: roots[0], mapped: labelsForDesktop(roots[0], spec.table) } : null;
      }
      var entry = cache[spec.table];
      if (!entry) return;
      var root = entry.root, mapped = entry.mapped;
      if (mapped) {
        var index = mapped.possible.findIndex(function(ids) { return ids.length === 1 && ids[0] === spec.first; });
        if (index >= 0 && mapped.possible[index + 1] && mapped.possible[index + 1].length === 1 && mapped.possible[index + 1][0] === spec.second &&
            !mapped.headers[index].hasAttribute("data-mk-detail-cell") && !mapped.headers[index + 1].hasAttribute("data-mk-detail-cell")) {
          mark(mapped.headers[index], spec.key + "-start"); mark(mapped.headers[index + 1], spec.key + "-end");
          desktopRows(mapped, spec);
        }
      }
      mobile(root, spec);
    });
  }
  function schedule() { if (state.pending) return; state.pending = true; if (typeof requestAnimationFrame === "function") requestAnimationFrame(refresh); else setTimeout(refresh, 0); }
  state.refresh = refresh;
  state.dispose = function() { if (state.disposed) return; state.disposed = true; if (state.observer) state.observer.disconnect(); clear(); window.removeEventListener("resize", schedule); if (state.style && state.style.textContent === css) state.style.remove(); if (container.__mkDetailCellPresentationV1 === state) delete container.__mkDetailCellPresentationV1; };
  state.observer = new MutationObserver(function(changes) {
    var markers = document.querySelectorAll("." + scope), marker = markers.length === 1 && markers[0];
    function related(node) {
      if (!node || node.nodeType !== 1 && node.nodeType !== 11) return false;
      if (marker && (node === marker || node.contains && node.contains(marker))) return true;
      return specs.some(function(spec) {
        var selector = '[data-id="' + spec.table + '"]';
        return node.matches && node.matches(selector) || node.closest && node.closest(selector) || node.querySelector && node.querySelector(selector);
      });
    }
    if (!marker || changes.some(function(change) { return related(change.target) ||
      Array.prototype.some.call(change.addedNodes || [], related) || Array.prototype.some.call(change.removedNodes || [], related); })) schedule();
  });
  state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "data-mk-detail-other"] });
  window.addEventListener("resize", schedule);
  refresh();
}

function invalid() {
  const error = new Error("Detail-cell presentation requires unique source-proven native field pairs.");
  error.code = "projection.detail_cell_presentation_invalid";
  return error;
}
