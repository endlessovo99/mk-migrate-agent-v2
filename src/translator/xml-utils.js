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
