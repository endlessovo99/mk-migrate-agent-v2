export function decodeEntities(value = "") {
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

export function parseXmlAttributes(text = "") {
  const result = {};
  for (const match of text.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    result[match[1]] = decodeEntities(match[3]);
  }
  return result;
}

export function parseRootHashMapStringPuts(xml = "") {
  const text = String(xml);
  const root = findOutermostHashMap(text);
  if (!root) return {};

  const rootClose = findMatchingElementClose(text, root.end, "object");
  if (!rootClose) return {};

  const values = {};
  let cursor = root.end;
  while (cursor < rootClose.start) {
    const child = findNextOpeningElement(text, cursor, rootClose.start);
    if (!child) break;

    if (child.selfClosing) {
      cursor = child.end;
      continue;
    }

    const childClose = findMatchingElementClose(text, child.end, child.name);
    if (!childClose || childClose.end > rootClose.start) break;

    if (child.name.toLowerCase() === "void" && attrValue(child.tag, "method") === "put") {
      const pair = parseDirectStringPair(text.slice(child.end, childClose.start));
      if (pair && values[pair.key] === undefined) {
        values[pair.key] = pair.value;
      }
    }

    cursor = childClose.end;
  }

  return values;
}

export function parseRootHashMapValue(xml = "", key) {
  const text = String(xml);
  const root = findOutermostHashMap(text);
  if (!root) return undefined;

  const rootClose = findMatchingElementClose(text, root.end, "object");
  if (!rootClose) return undefined;

  for (const child of findDirectChildElements(text, root.end, rootClose.start)) {
    if (child.name.toLowerCase() !== "void" || attrValue(child.tag, "method") !== "put") continue;
    const entries = findDirectChildElements(text, child.end, child.closeStart);
    if (entries.length !== 2 || entries[0].name.toLowerCase() !== "string") continue;
    if (parseJavaDecoderElement(text, entries[0]) !== key) continue;
    return parseJavaDecoderElement(text, entries[1]);
  }

  return undefined;
}

export function parseFdValues(value = "") {
  const result = {};
  for (const match of decodeEntities(value).matchAll(/([\w$]+)\s*:\s*"([^"]*)"/g)) {
    result[match[1]] = decodeEntities(match[2]);
  }
  return result;
}

export function parseOptions(value = "") {
  const text = decodeEntities(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return [];
  return text
    .split(/\n|;/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [label, optionValue] = item.includes("|") ? item.split("|", 2) : [item, item];
      return { label: cleanText(label), value: cleanText(optionValue) };
    })
    .filter((item) => item.label && item.value);
}

export function cleanText(value = "") {
  return decodeEntities(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function attrValue(text = "", name) {
  const match = String(text).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.slice(1).find((value) => value !== undefined) || "";
}

export function propertyFieldId(value = "") {
  const match = String(value).match(/(?:^|value\()([A-Za-z_][\w-]*)(?:[.)]|$)/);
  return match?.[1] || "";
}

export function removeRanges(text, ranges) {
  if (!ranges.length) return text;
  let result = "";
  let cursor = 0;
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    result += text.slice(cursor, start);
    cursor = end;
  }
  return result + text.slice(cursor);
}

function findOutermostHashMap(xml) {
  const javaMatch = /<java\b[^>]*>/i.exec(xml);
  if (!javaMatch || isSelfClosingTag(javaMatch[0])) return undefined;
  const javaEnd = javaMatch.index + javaMatch[0].length;
  const javaClose = findMatchingElementClose(xml, javaEnd, "java");
  if (!javaClose) return undefined;

  const root = findNextOpeningElement(xml, javaEnd, javaClose.start);
  if (
    !root ||
    root.selfClosing ||
    root.name.toLowerCase() !== "object" ||
    attrValue(root.tag, "class") !== "java.util.HashMap"
  ) {
    return undefined;
  }
  return root;
}

function findNextOpeningElement(xml, cursor, limit) {
  const pattern = /<([A-Za-z_][\w:.-]*)\b[^>]*>/g;
  pattern.lastIndex = cursor;
  const match = pattern.exec(xml);
  if (!match || match.index >= limit) return undefined;
  return {
    name: match[1],
    tag: match[0],
    start: match.index,
    end: match.index + match[0].length,
    selfClosing: isSelfClosingTag(match[0])
  };
}

function findMatchingElementClose(xml, cursor, tagName) {
  const pattern = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, "gi");
  pattern.lastIndex = cursor;
  let depth = 1;

  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    const tag = match[0];
    if (isClosingTag(tag)) {
      depth -= 1;
      if (depth === 0) {
        return {
          start: match.index,
          end: match.index + tag.length
        };
      }
    } else if (!isSelfClosingTag(tag)) {
      depth += 1;
    }
  }

  return undefined;
}

function findDirectChildElements(xml, cursor, limit) {
  const elements = [];
  while (cursor < limit) {
    const child = findNextOpeningElement(xml, cursor, limit);
    if (!child) break;

    if (child.selfClosing) {
      elements.push({ ...child, closeStart: child.end, closeEnd: child.end });
      cursor = child.end;
      continue;
    }

    const close = findMatchingElementClose(xml, child.end, child.name);
    if (!close || close.end > limit) break;
    elements.push({ ...child, closeStart: close.start, closeEnd: close.end });
    cursor = close.end;
  }
  return elements;
}

function parseJavaDecoderElement(xml, element) {
  const name = element.name.toLowerCase();
  const body = element.selfClosing ? "" : xml.slice(element.end, element.closeStart);

  if (name === "string" || name === "char") return decodeEntities(body);
  if (["int", "long", "short", "byte", "float", "double"].includes(name)) {
    const value = Number(body.trim());
    return Number.isNaN(value) ? undefined : value;
  }
  if (name === "boolean") return body.trim().toLowerCase() === "true";
  if (name === "null") return null;
  if (name !== "object") return undefined;

  const className = attrValue(element.tag, "class");
  if (className === "java.util.ArrayList") {
    if (element.selfClosing) return [];
    return findDirectChildElements(xml, element.end, element.closeStart)
      .filter((child) => child.name.toLowerCase() === "void" && attrValue(child.tag, "method") === "add")
      .map((child) => findDirectChildElements(xml, child.end, child.closeStart)[0])
      .filter(Boolean)
      .map((child) => parseJavaDecoderElement(xml, child));
  }

  if (className === "java.util.HashMap") {
    if (element.selfClosing) return {};
    const result = {};
    for (const child of findDirectChildElements(xml, element.end, element.closeStart)) {
      if (child.name.toLowerCase() !== "void" || attrValue(child.tag, "method") !== "put") continue;
      const entries = findDirectChildElements(xml, child.end, child.closeStart);
      if (entries.length !== 2) continue;
      const key = parseJavaDecoderElement(xml, entries[0]);
      if (typeof key !== "string" || result[key] !== undefined) continue;
      result[key] = parseJavaDecoderElement(xml, entries[1]);
    }
    return result;
  }

  return undefined;
}

function parseDirectStringPair(body) {
  const match = String(body).match(
    /^\s*<string\b[^>]*>([\s\S]*?)<\/string>\s*<string\b[^>]*>([\s\S]*?)<\/string>\s*$/i
  );
  if (!match) return undefined;
  return {
    key: decodeEntities(match[1]),
    value: decodeEntities(match[2])
  };
}

function isClosingTag(tag) {
  return /^<\//.test(tag);
}

function isSelfClosingTag(tag) {
  return /\/\s*>$/.test(tag);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
