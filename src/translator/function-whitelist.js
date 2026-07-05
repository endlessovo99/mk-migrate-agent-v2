import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const IGNORED_FUNCTIONS = new Set([
  "$",
  "jQuery",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "parseInt",
  "parseFloat",
  "Number",
  "String",
  "Boolean",
  "Date",
  "Array",
  "Object",
  "Math.round",
  "Math.floor",
  "Math.ceil",
  "Math.max",
  "Math.min",
  "JSON.stringify",
  "JSON.parse",
  "url",
  "Com_IncludeFile",
  "DocList_Info.push",
  "DocList_MoveRow"
]);

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "typeof",
  "new"
]);

export function loadFunctionWhitelist(path) {
  if (!path) return undefined;
  const extension = extname(path).toLowerCase();
  const entries = extension === ".json" ? loadJsonWhitelist(path) : loadWorkbookWhitelist(path);
  const byName = new Map();

  for (const entry of entries) {
    if (!entry.name || byName.has(entry.name)) continue;
    byName.set(entry.name, entry);
  }

  return {
    sourcePath: path,
    entries: [...byName.values()],
    byName
  };
}

export function auditFunctionWhitelist(text, whitelist, options = {}) {
  if (!whitelist) {
    return {
      sourcePath: "",
      matched: [],
      violations: []
    };
  }

  const calls = extractFunctionCalls(text);
  const matched = [];
  const violations = [];

  for (const call of calls) {
    const whitelistEntry = whitelist.byName.get(call.name);
    if (whitelistEntry) {
      matched.push({
        ...whitelistEntry,
        occurrences: call.occurrences
      });
      continue;
    }

    violations.push({
      name: call.name,
      occurrences: call.occurrences
    });
  }

  return {
    sourcePath: whitelist.sourcePath,
    path: options.path || "",
    matched,
    violations
  };
}

export function functionWhitelistErrors(audit, path = "/review/functionWhitelist") {
  return audit.violations.map((violation) => ({
    code: "source.function_not_whitelisted",
    message: `Source function ${violation.name} is not in the translation whitelist.`,
    path,
    details: {
      functionName: violation.name,
      occurrences: violation.occurrences
    }
  }));
}

export function extractFunctionCalls(text = "") {
  const decoded = decodeEntities(String(text));
  const calls = new Map();
  const pattern = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;

  for (const match of decoded.matchAll(pattern)) {
    const previous = decoded[match.index - 1] || "";
    const name = match[1];
    if (previous === ".") continue;
    if (KEYWORDS.has(name)) continue;
    if (IGNORED_FUNCTIONS.has(name)) continue;

    const occurrence = {
      index: match.index,
      snippet: snippetAt(decoded, match.index)
    };

    if (!calls.has(name)) {
      calls.set(name, {
        name,
        occurrences: []
      });
    }
    calls.get(name).occurrences.push(occurrence);
  }

  return [...calls.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function loadJsonWhitelist(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const rows = Array.isArray(parsed) ? parsed : parsed.functions;
  if (!Array.isArray(rows)) {
    throw new Error("function whitelist JSON must be an array or contain a functions array");
  }

  return rows.map((row) => ({
    name: clean(row.name ?? row["函数名"]),
    description: clean(row.description ?? row["函数作用说明"]),
    mkFunction: clean(row.mkFunction ?? row["对应的MK函数"])
  })).filter((row) => row.name);
}

function loadWorkbookWhitelist(path) {
  const sharedStrings = parseSharedStrings(unzipXml(path, "xl/sharedStrings.xml"));
  const sheetXml = unzipXml(path, "xl/worksheets/sheet1.xml");
  const rows = parseSheetRows(sheetXml, sharedStrings);
  const headerIndex = rows.findIndex((row) => row.some((cell) => clean(cell)));
  if (headerIndex === -1) {
    throw new Error("function whitelist workbook does not contain a header row");
  }

  const header = rows[headerIndex].map(clean);
  const nameIndex = findHeaderIndex(header, ["函数名", "function", "函数"]);
  const descriptionIndex = findHeaderIndex(header, ["函数作用说明", "说明", "description"]);
  const mkFunctionIndex = findHeaderIndex(header, ["对应的MK函数", "mk函数", "mkfunction", "目标函数"]);

  if (nameIndex === -1 || mkFunctionIndex === -1) {
    throw new Error("function whitelist workbook requires 函数名 and 对应的MK函数 columns");
  }

  return rows.slice(headerIndex + 1).map((row) => ({
    name: clean(row[nameIndex]),
    description: descriptionIndex === -1 ? "" : clean(row[descriptionIndex]),
    mkFunction: clean(row[mkFunctionIndex])
  })).filter((row) => row.name);
}

function unzipXml(path, member) {
  try {
    return execFileSync("unzip", ["-p", path, member], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (error) {
    throw new Error(`failed to read ${member} from function whitelist workbook: ${error.message}`);
  }
}

function parseSharedStrings(xml = "") {
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((match) => {
    const item = match[0];
    return [...item.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((textMatch) => decodeEntities(textMatch[1]))
      .join("");
  });
}

function parseSheetRows(xml = "", sharedStrings = []) {
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((rowMatch) => {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = parseXmlAttributes(cellMatch[1]);
      const index = columnIndex(attrs.r || "");
      cells[index] = parseCellValue(cellMatch[2], attrs, sharedStrings);
    }
    return cells.map((cell) => cell ?? "");
  });
}

function parseCellValue(xml, attrs, sharedStrings) {
  if (attrs.t === "inlineStr") {
    const textMatch = xml.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
    return textMatch ? decodeEntities(textMatch[1]) : "";
  }

  const valueMatch = xml.match(/<v>([\s\S]*?)<\/v>/);
  if (!valueMatch) return "";
  const value = decodeEntities(valueMatch[1]);
  if (attrs.t === "s") return sharedStrings[Number.parseInt(value, 10)] || "";
  return value;
}

function findHeaderIndex(header, candidates) {
  return header.findIndex((item) => {
    const normalized = item.toLowerCase().replace(/\s+/g, "");
    return candidates.some((candidate) => normalized === candidate.toLowerCase().replace(/\s+/g, ""));
  });
}

function columnIndex(ref = "") {
  const letters = /^[A-Z]+/i.exec(ref)?.[0] || "A";
  let result = 0;
  for (const letter of letters.toUpperCase()) {
    result = result * 26 + letter.charCodeAt(0) - 64;
  }
  return result - 1;
}

function parseXmlAttributes(text = "") {
  const result = {};
  for (const match of text.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    result[match[1]] = decodeEntities(match[3]);
  }
  return result;
}

function snippetAt(text, index) {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + 100);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function clean(value = "") {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function decodeEntities(value = "") {
  return String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&amp;#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
