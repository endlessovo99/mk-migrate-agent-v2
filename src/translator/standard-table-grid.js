import { parse } from "acorn";
import { scanHtmlTags, isVoidLikeTag } from "./designer-html-tokenizer.js";
import { parseDesignerFdValues, parseDesignerControlAttributes, parseStaticDesignerStringValues } from "./designer-control-values.js";
import { cleanText, decodeEntities } from "./xml-utils.js";

export function isStaticHeaderGridShape(controlRows = []) {
  if (controlRows.length < 2) return false;
  const [header, ...body] = controlRows;
  if (rowColumns(header) < 3 || header.filter(isNonEmptyDescriptionCell).length < 2) return false;
  if (!header.every(cell => controls(cell).length === 0 || isNonEmptyDescriptionCell(cell))) return false;
  if (!body.every(row => rowColumns(row) === rowColumns(header))) return false;

  // A blank corner and later merged explanation rows do not remove the column
  // headings. Require an input row that actually aligns with those headings.
  return body.some(row => row.filter(cell => hasInputControl(cell) && header.some(heading =>
    isNonEmptyDescriptionCell(heading) && heading.column === cell.column && heading.colspan === cell.colspan
  )).length >= 2);
}

export function isStaticDescriptionGridShape(controlRows = []) {
  if (controlRows.length < 2) return false;
  const [header, ...body] = controlRows;
  if (header.length < 3) return false;
  if (!header.every(isNonEmptyDescriptionCell)) return false;
  if (!body.length) return false;

  return body.every((row) =>
    row.length === header.length && rowColumns(row) === rowColumns(header) && row.every(isNonEmptyDescriptionCell)
  );
}

function isNonEmptyDescriptionCell(cell = []) {
  return controls(cell).length > 0 && controls(cell).every((control) => control.description === true);
}

function hasInputControl(cell = []) {
  return controls(cell).some((control) => control.description !== true);
}

function controls(cell) { return cell.controls || cell; }
function rowColumns(row) {
  return Math.max(0, ...row.map((cell, index) => (cell.column ?? index) + (cell.colspan ?? 1)));
}

// A bounded static grid is supported only when existing layout composition
// can reproduce every occupied source rectangle, including its full height.
export function staticRectangleGridProfile(rows = [], { maxColumns = 8 } = {}) {
  if (rows.length < 2 || rows.some(row => row.sourceMarkers?.length)) return undefined;
  const height = rows.length;
  const cells = rows.flatMap((row, index) => (row.cells || []).map(cell => ({ ...cell, row: index })));
  if (!cells.some(cell => cell.rowspan > 1)) return undefined;
  const columns = Math.max(0, ...cells.map(cell => cell.column + cell.colspan));
  if (columns < 1 || columns > maxColumns * 2) return undefined;
  const occupied = Array.from({ length: height }, () => Array(columns).fill(false));
  const ids = new Set();
  for (const cell of cells) {
    if (cell.coordinatesValid === false || ![cell.row, cell.column, cell.colspan, cell.rowspan].every(Number.isSafeInteger) ||
        cell.column < 0 || cell.colspan < 1 || cell.rowspan < 1 || cell.column + cell.colspan > columns || cell.row + cell.rowspan > height ||
        !cell.controls?.length || cell.controls.some(control => !control.id || control.hidden || control.detail)) return undefined;
    for (const control of cell.controls) {
      if (ids.has(control.id)) return undefined;
      ids.add(control.id);
    }
    for (let row = cell.row; row < cell.row + cell.rowspan; row++) {
      for (let column = cell.column; column < cell.column + cell.colspan; column++) {
        if (occupied[row][column]) return undefined;
        occupied[row][column] = true;
      }
    }
  }
  if (occupied.some(row => row.some(value => !value))) return undefined;
  const memo = new Map();
  const build = (top, left, bottom, right) => {
    const key = [top, left, bottom, right].join(":");
    if (memo.has(key)) return memo.get(key);
    memo.set(key, undefined);
    const region = cells.filter(cell => cell.row >= top && cell.row < bottom && cell.column >= left && cell.column < right);
    const regionHeight = bottom - top, width = right - left;
    if (region.length === 1 && region[0].rowspan === regionHeight && region[0].colspan === width) {
      const result = { type: "leaf", cell: region[0], height: 1 };
      memo.set(key, result); return result;
    }
    const cuts = Array.from({ length: width - 1 }, (_, index) => left + index + 1)
      .filter(cut => !region.some(cell => cell.column < cut && cell.column + cell.colspan > cut));
    const partitions = [cuts, ...cuts.slice().sort((a, b) => Math.abs(a - (left + right) / 2) - Math.abs(b - (left + right) / 2)).map(cut => [cut])];
    for (const partition of partitions) {
      if (!partition.length) continue;
      const edges = [left, ...partition, right];
      const unit = edges.slice(1).reduce((value, edge, index) => gcd(value, edge - edges[index]), width);
      if (width / unit > maxColumns) continue;
      const children = edges.slice(1).map((edge, index) => ({
        column: (edges[index] - left) / unit,
        colspan: (edge - edges[index]) / unit,
        plan: build(top, edges[index], bottom, edge)
      }));
      if (children.some(child => !child.plan || (child.plan.type !== "leaf" && child.plan.height !== regionHeight))) continue;
      const actualHeight = Math.max(...children.map(child => child.plan.height));
      if (actualHeight !== regionHeight) continue;
      const result = { type: "grid", columns: width / unit, children, height: actualHeight };
      memo.set(key, result); return result;
    }
    const horizontal = Array.from({ length: regionHeight - 1 }, (_, index) => top + index + 1)
      .filter(cut => !region.some(cell => cell.row < cut && cell.row + cell.rowspan > cut));
    if (horizontal.length) {
      const edges = [top, ...horizontal, bottom];
      const children = edges.slice(1).map((edge, index) => build(edges[index], left, edge, right));
      if (children.every((child, index) => child && child.height === edges[index + 1] - edges[index])) {
        const result = { type: "stack", children, height: regionHeight };
        memo.set(key, result); return result;
      }
    }
    return undefined;
  };
  const plan = build(0, 0, height, columns);
  if (!plan || plan.height !== height) return undefined;
  const twoLevelHeader = height === 3 && rows.slice(0, 2).every(row =>
    row.cells.every(cell => cell.controls.every(control => control.description))) &&
    rows[2].cells.every(cell => cell.colspan === 1 && cell.rowspan === 1) &&
    rows[2].cells.filter(cell => cell.controls.some(control => !control.description)).length >= 2;
  const headerCaptionIds = twoLevelHeader ? Array.from({ length: columns }, (_, column) => {
    const heading = rows[1].cells.find(cell => cell.column <= column && cell.column + cell.colspan > column) ||
      rows[0].cells.find(cell => cell.rowspan === 2 && cell.column <= column && cell.column + cell.colspan > column);
    return heading.controls.map(control => control.id);
  }) : undefined;
  return { columns, rows: height, plan, headerRows: twoLevelHeader ? 2 : 0, headerCaptionIds };
}

function gcd(left, right) {
  while (right) [left, right] = [right, left % right];
  return left;
}
// Consume complete classic designer faces. FD declarations own scalar
// templates and their exact required/selector faces, not arbitrary subtrees.
export function staticRectangleCellContent(html, controls, tableId) {
  if (/<!--|<%/.test(html)) return false;
  const root = { children: [], text: "" }, stack = [root];
  let offset = 0;
  for (const token of scanHtmlTags(html)) {
    stack.at(-1).text += html.slice(offset, token.start); offset = token.end;
    if (token.closing) {
      if (stack.length < 2 || stack.at(-1).name !== token.name || token.attrs.trim()) return false;
      stack.at(-1).body = html.slice(stack.at(-1).bodyStart, token.start); stack.pop(); continue;
    }
    const declared = /(?:^|\s)fd_values\s*=/i.test(token.attrs);
    const values = declared ? parseDesignerFdValues(token.attrs) : undefined;
    const attrs = declared ? parseDesignerControlAttributes(token.attrs) : rectangleAttributes(token.attrs, ["input", "textarea"].includes(token.name));
    if (declared && !parseStaticDesignerStringValues(token.attrs, new Set(Object.keys(values)), new Set(Object.keys(values)))) return false;
    if (!attrs) return false;
    const node = { name: token.name, attrs, values, children: [], text: "", bodyStart: token.end, body: "" };
    stack.at(-1).children.push(node);
    if (!token.selfClosing && !isVoidLikeTag(token.name)) stack.push(node);
  }
  stack.at(-1).text += html.slice(offset);
  if (stack.length !== 1) return false;
  const blank = value => decodeEntities(value || "").trim() === "";
  const keys = (node, allowed) => node && [...node.attrs.keys()].every(key => allowed.includes(key));
  const empty = node => node && !node.children.length && blank(node.text);
  const style = value => (value || "").split(";").every(part => {
    if (!part.trim()) return true;
    const match = /^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i.exec(part);
    return match && ["display", "width", "height", "min-height", "vertical-align", "text-align", "text-decoration", "font-weight", "font-style",
      "border", "border-top", "border-left", "border-right", "border-bottom", "padding", "padding-top", "padding-left", "padding-right", "padding-bottom",
      "cursor", "position", "background-color", "border-collapse", "float", "margin", "line-height", "background"].includes(match[1].toLowerCase()) &&
      (/^[\w#.%+-]+(?:\s+[\w#.%+-]+)*$/.test(match[2]) || match[1].toLowerCase() === "background" &&
        /^url\(style\/img\/right_icon\.gif\)\s+no-repeat\s+0px\s+-?\d+px$/.test(match[2]));
  });
  const seen = new Set(), byId = new Map(controls.map(control => [control.id, control]));
  const call = (text, expected) => {
    const comments = []; let program;
    try { program = parse(text || "", { ecmaVersion: "latest", onComment: comments }); } catch { return false; }
    return !comments.length && program.body.length === expected.length && program.body.every((statement, index) => {
      const expression = statement.expression, [name, argument] = expected[index];
      return statement.type === "ExpressionStatement" && expression?.type === "CallExpression" && !expression.optional &&
        expression.callee.type === "Identifier" && expression.callee.name === name && expression.arguments.length === 1 &&
        (argument === "this" ? expression.arguments[0].type === "ThisExpression" :
          expression.arguments[0].type === "Identifier" && expression.arguments[0].name === argument);
    });
  };
  const cancel = [["Designer_Control_Right_CancelBubbleFun", "event"]];
  const scalar = node => {
    const values = node.values || {};
    const type = node.attrs.get("fd_type")?.toLowerCase(), id = values.id || node.attrs.get("id");
    if (!keys(node, ["id", "style", "class", "formdesign", "fd_values", "fd_type", "canshow"]) || !style(node.attrs.get("style")) ||
        ![undefined, "landray"].includes(node.attrs.get("formdesign")) || ![undefined, "", "inputsgl"].includes(node.attrs.get("class")) ||
        node.attrs.has("id") && node.attrs.get("id") !== id || node.attrs.has("canshow") && node.attrs.get("canshow") !== (values.canShow || "true")) return false;
    if (type === "right") return right(node, values);
    const control = byId.get(id);
    if (!control || seen.has(id) || String(control.source?.designerType).toLowerCase() !== type) return false;
    seen.add(id);
    if (type === "textlabel") {
      const literal = child => ["br", "span", "div", "p", "label"].includes(child.name) && child.attrs.size === 0 && child.children.every(literal);
      return ["label", "div", "span"].includes(node.name) && node.children.every(literal) &&
        cleanText(node.body) === cleanText(control.source?.designerValues?.content || control.title);
    }
    if (!["inputtext", "datetime", "textarea", "restdialog"].includes(type) || !["div", "label"].includes(node.name) || !blank(node.text)) return false;
    const children = [...node.children], input = children.shift(), expectedTag = type === "textarea" ? "textarea" : "input";
    const mirrored = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
    for (const [key, value] of [["required", "false"], ["canshow", "true"], ["readonly", "false"], ["thousandshow", "false"], ["defaultvalue", ""]]) {
      if (!mirrored.has(key)) mirrored.set(key, value);
    }
    const editorFace = node.attrs.get("formdesign") === "landray";
    const inputKeys = ["id", "class", "style", "readonly", "label", "canshow", "tablename", "required", "_required", "_readonly", "thousandshow", "defaultvalue"];
    if (type === "datetime") inputKeys.push("businesstype");
    if (type === "restdialog") inputKeys.push("multiselect", "businesstype", "isloaddata", "isshowtree", "restapichangeafter", "restapichangebefore", "outputparams", "inputparams", "selectnodelevel", "searchkey", "restapipath", "secret", "secretkey", "isenablesecret", "parentnodeidcolumn", "requestmethod", "txtreadonly", "showtype");
    if (type === "restdialog") {
      for (const key of inputKeys) if (!mirrored.has(key) && mirrored.has(`_${key}`)) mirrored.set(key, mirrored.get(`_${key}`));
      for (const key of ["restapichangeafter", "restapichangebefore", "inputparams", "outputparams", "selectnodelevel", "parentnodeidcolumn"]) {
        if (!mirrored.has(key)) mirrored.set(key, "");
      }
    }
    if (!input || input.name !== expectedTag || input.children.length || !keys(input, inputKeys) || !style(input.attrs.get("style")) ||
        ![undefined, type === "textarea" ? "inputmul" : "inputsgl", ""].includes(input.attrs.get("class")) || input.attrs.has("id") && input.attrs.get("id") !== id ||
        input.attrs.has("readonly") && input.attrs.get("readonly") !== "" && !(editorFace && ["true", "readonly"].includes(input.attrs.get("readonly"))) ||
        !blank(input.text) && input.text !== (values.defaultValue || "")) return false;
    for (const [key, value] of input.attrs) {
      if (["id", "class", "style", "readonly"].includes(key)) continue;
      if (key === "tablename") { if (![tableId, control.source?.rightContainer?.id].includes(value)) return false; continue; }
      const sourceKey = key === "_required" ? "required" : key === "_readonly" ? "readonly" : key;
      // DateTime's classic editor reuses the numeric display face. Its
      // undeclared boolean switch is not a date value or a field property.
      const dateFaceFlag = key === "thousandshow" && type === "datetime" && editorFace &&
        !Object.keys(values).some(key => key.toLowerCase() === "thousandshow") && ["", "true", "false"].includes(value);
      if (value !== mirrored.get(sourceKey) && !(key === "required" && value === "" && (values.required === "true" || editorFace)) &&
          !(key === "thousandshow" && value === "" && mirrored.get(sourceKey) === "false") && !dateFaceFlag) return false;
      if (["restapichangeafter", "restapichangebefore"].includes(key) && value !== "") return false;
    }
    if (children[0]?.name === "span") {
      const star = children.shift();
      if (values.required !== "true" || star.attrs.size !== 1 || star.attrs.get("class") !== "txtstrong" || star.children.length || star.text.trim() !== "*") return false;
    }
    if (!children.length) return true;
    const selector = children[0], anchor = selector?.children[0];
    return ["datetime", "restdialog"].includes(type) && children.length === 1 && selector.name === "label" && selector.attrs.size === 0 &&
      blank(selector.text) && selector.children.length === 1 && anchor.name === "a" && anchor.attrs.size === 0 &&
      !anchor.children.length && cleanText(anchor.text) === "选择";
  };
  const right = (node, values) => {
    if (node.name !== "div" || !blank(node.text) || node.children.length !== 3 || !controls.some(control => control.source?.rightContainer?.id === values.id)) return false;
    const [icon, table, child] = node.children;
    if (icon.name !== "div" || !empty(icon) || !keys(icon, ["class", "style"]) || icon.attrs.get("class") !== "rightIconBar" || !style(icon.attrs.get("style")) ||
        table.name !== "table" || !keys(table, ["class", "style", "cellpadding"]) || table.attrs.get("class") !== "righBar" ||
        ![undefined, "0", "1"].includes(table.attrs.get("cellpadding")) || !style(table.attrs.get("style")) || !blank(table.text) || table.children.length !== 1) return false;
    const tbody = table.children[0], tr = tbody?.children[0];
    if (tbody.name !== "tbody" || tbody.attrs.size || !blank(tbody.text) || tbody.children.length !== 1 || tr.name !== "tr" ||
        !keys(tr, ["style"]) || !style(tr.attrs.get("style")) || !blank(tr.text) || tr.children.length !== 3 ||
        tr.children.some(td => td.name !== "td" || !keys(td, ["style"]) || !style(td.attrs.get("style")) || !blank(td.text))) return false;
    const [first, second, third] = tr.children;
    if (first.children.length !== 2 || second.children.length !== 1 || third.children.length !== 1) return false;
    const buttons = [first.children[0], first.children[1], second.children[0]];
    const kinds = ["mode", "default", "reader"];
    for (let index = 0; index < buttons.length; index++) {
      const button = buttons[index], kind = kinds[index];
      const attrs = ["onclick", "ondblclick", "onmousedown", "title", "class", "style"];
      if (button.name !== "button" || !empty(button) || button.attrs.get("class") !== `${kind}Cell` || !style(button.attrs.get("style")) ||
          [...button.attrs.keys()].some(key => !attrs.includes(key) && !(kind === "mode" && /^mode_(?:n\d+|g|d)$/.test(key) ||
            kind === "default" && /^def_(?:n\d+|d)$/.test(key) || kind === "reader" && ["readerids", "readernames"].includes(key))) ||
          !call(button.attrs.get("onclick"), [[`Designer_Control_Right_Set${kind === "mode" ? "Mode" : kind === "default" ? "Default" : "Reader"}CellValue`, "this"]]) ||
          !call(button.attrs.get("ondblclick"), cancel) || !call(button.attrs.get("onmousedown"), cancel)) return false;
    }
    const caption = third.children[0];
    // This span belongs to the proven SDK editor toolbar, outside its scalar
    // child. Permission names come only from the FD rightName declaration.
    const defaultEditorTitle = node.attrs.get("formdesign") === "landray" && !Object.hasOwn(values, "rightName") &&
      /^权限区段[1-9]\d*$/.test(cleanText(caption.text));
    return caption.name === "span" && !caption.children.length && keys(caption, ["ondblclick", "style"]) && style(caption.attrs.get("style")) &&
      (cleanText(caption.text) === cleanText(values.rightName || "") || defaultEditorTitle) &&
      call(caption.attrs.get("ondblclick"), [...cancel, ["Designer_Control_Right_ShowLabelEditor", "this"]]) && scalar(child);
  };
  const consume = node => node.attrs.has("fd_type") ? scalar(node) :
    ["div", "span"].includes(node.name) && node.attrs.size === 0 && blank(node.text) && node.children.every(consume);
  return blank(root.text) && root.children.length > 0 && root.children.every(consume) && seen.size === controls.length;
}

function rectangleAttributes(text, input) {
  const attrs = new Map(), source = text.replace(/\/\s*$/, "");
  const rule = /\s*([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/y;
  let offset = 0, previous, preview = false;
  while (source.slice(offset).trim()) {
    const rest = /^\s*\?(?=\s|$)/.exec(source.slice(offset));
    if (rest) {
      // Classic scalar editor faces can retain one inert exporter placeholder.
      // It is not a readonly flag or an expression and carries no value.
      if (!input || preview) return undefined;
      preview = true; offset += rest[0].length; continue;
    }
    if (offset && !/\s/.test(source[offset])) return undefined;
    rule.lastIndex = offset; const match = rule.exec(source), key = match?.[1].toLowerCase();
    if (!match || attrs.has(key)) return undefined;
    attrs.set(key, decodeEntities(match[2] ?? match[3] ?? match[4] ?? "")); previous = key; offset = rule.lastIndex;
  }
  return attrs;
}
