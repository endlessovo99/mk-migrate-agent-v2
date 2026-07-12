export function isProvablyInertVariableDeclaration(statement) {
  let text = String(statement || "").trim().replace(/;\s*$/, "");
  const declaration = text.match(/^(?:var|let|const)\b/);
  if (!declaration) return false;
  text = text.slice(declaration[0].length);

  let offset = 0;
  let declarations = 0;
  while (offset < text.length) {
    offset = skipWhitespace(text, offset);
    const name = text.slice(offset).match(/^[A-Za-z_$][\w$]*/);
    if (!name) return false;
    declarations += 1;
    offset += name[0].length;
    offset = skipWhitespace(text, offset);
    if (text[offset] === "=") {
      const valueStart = skipWhitespace(text, offset + 1);
      const valueEnd = findTopLevelComma(text, valueStart);
      if (!isPureLiteralExpression(text.slice(valueStart, valueEnd))) return false;
      offset = valueEnd;
    }
    offset = skipWhitespace(text, offset);
    if (offset >= text.length) break;
    if (text[offset] !== ",") return false;
    offset += 1;
  }
  return declarations > 0;
}

function isPureLiteralExpression(source) {
  const parser = new LiteralParser(source);
  return parser.parse();
}

class LiteralParser {
  constructor(source) {
    this.source = String(source || "");
    this.index = 0;
  }

  parse() {
    if (!this.parseValue()) return false;
    this.skipWhitespace();
    return this.index === this.source.length;
  }

  parseValue() {
    this.skipWhitespace();
    const char = this.source[this.index];
    if (["+", "-", "!", "~"].includes(char)) {
      this.index += 1;
      return this.parseValue();
    }
    if (char === "\"" || char === "'") return this.parseQuotedString(char);
    if (char === "`") return this.parseStaticTemplate();
    if (char === "[") return this.parseArray();
    if (char === "{") return this.parseObject();
    const number = this.source.slice(this.index).match(/^(?:0[xob][0-9a-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i);
    if (number) {
      this.index += number[0].length;
      return true;
    }
    for (const keyword of ["true", "false", "null", "undefined", "NaN", "Infinity"]) {
      if (this.source.startsWith(keyword, this.index) && !/[\w$]/.test(this.source[this.index + keyword.length] || "")) {
        this.index += keyword.length;
        return true;
      }
    }
    return false;
  }

  parseQuotedString(quote) {
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === "\\") {
        this.index += 2;
        continue;
      }
      this.index += 1;
      if (char === quote) return true;
      if (char === "\n" || char === "\r") return false;
    }
    return false;
  }

  parseStaticTemplate() {
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === "\\") {
        this.index += 2;
        continue;
      }
      if (char === "$" && this.source[this.index + 1] === "{") return false;
      this.index += 1;
      if (char === "`") return true;
    }
    return false;
  }

  parseArray() {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("]")) return true;
    while (this.index < this.source.length) {
      if (!this.parseValue()) return false;
      this.skipWhitespace();
      if (this.consume("]")) return true;
      if (!this.consume(",")) return false;
      this.skipWhitespace();
      if (this.consume("]")) return true;
    }
    return false;
  }

  parseObject() {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("}")) return true;
    while (this.index < this.source.length) {
      if (!this.parseObjectKey()) return false;
      this.skipWhitespace();
      if (!this.consume(":")) return false;
      if (!this.parseValue()) return false;
      this.skipWhitespace();
      if (this.consume("}")) return true;
      if (!this.consume(",")) return false;
      this.skipWhitespace();
      if (this.consume("}")) return true;
    }
    return false;
  }

  parseObjectKey() {
    this.skipWhitespace();
    const char = this.source[this.index];
    if (char === "\"" || char === "'") return this.parseQuotedString(char);
    const key = this.source.slice(this.index).match(/^(?:[A-Za-z_$][\w$]*|(?:\d+\.?\d*|\.\d+))/);
    if (!key) return false;
    this.index += key[0].length;
    return true;
  }

  consume(value) {
    if (!this.source.startsWith(value, this.index)) return false;
    this.index += value.length;
    return true;
  }

  skipWhitespace() {
    this.index = skipWhitespace(this.source, this.index);
  }
}

function findTopLevelComma(text, start) {
  const depths = { "(": 0, "[": 0, "{": 0 };
  let quote = "";
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (["\"", "'", "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === "(") depths["("] += 1;
    if (char === "[") depths["["] += 1;
    if (char === "{") depths["{"] += 1;
    if (char === ")") depths["("] -= 1;
    if (char === "]") depths["["] -= 1;
    if (char === "}") depths["{"] -= 1;
    if (char === "," && Object.values(depths).every((depth) => depth === 0)) return index;
  }
  return text.length;
}

function skipWhitespace(text, start) {
  let index = start;
  while (/\s/.test(text[index] || "")) index += 1;
  return index;
}
