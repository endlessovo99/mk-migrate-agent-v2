export function sourceFormRulesFromLegacyScripts(scripts) {
  const sources = Array.isArray(scripts?.sources) ? scripts.sources : [];
  const linkage = [];
  const seen = new Set();

  for (const source of sources) {
    for (const rule of extractNativeLinkageRules(source)) {
      if (seen.has(rule.id)) continue;
      seen.add(rule.id);
      linkage.push(rule);
    }
  }

  if (!linkage.length) return undefined;
  return {
    linkage,
    validations: [],
    impliedRequired: [],
    review: {}
  };
}

function extractNativeLinkageRules(source) {
  const javascript = source?.javascript || "";
  const callbacks = extractXFormValueChangeCallbacks(javascript);
  const rules = [];

  for (const callback of callbacks) {
    for (const block of extractTopLevelIfElseBlocks(callback.body)) {
      const value = conditionLiteralValue(block.condition);
      if (!value) continue;

      const effects = extractDirectRowEffects(block.thenBody);
      const elseEffects = extractDirectRowEffects(block.elseBody);
      if (!effects.length || !elseEffects.length) continue;

      rules.push({
        id: `linkage.${callback.source}.contains.${stableIdPart(value)}`,
        trigger: "change",
        source: callback.source,
        logic: "and",
        when: [{
          field: callback.source,
          op: "contains",
          value
        }],
        effects,
        else: elseEffects,
        meta: {
          sourceJsp: source.sourceRef
        },
        translationStatus: "executable"
      });
    }
  }

  return rules;
}

function extractXFormValueChangeCallbacks(javascript) {
  const callbacks = [];
  const pattern = /AttachXFormValueChangeEventById\(\s*(["'])([^"']+)\1\s*,\s*function\s*\([^)]*\)\s*\{/g;

  for (const match of javascript.matchAll(pattern)) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findBalancedClose(javascript, bodyStart - 1, "{", "}");
    if (bodyEnd < bodyStart) continue;
    callbacks.push({
      source: match[2],
      body: javascript.slice(bodyStart, bodyEnd)
    });
  }

  return callbacks;
}

function extractTopLevelIfElseBlocks(body) {
  const blocks = [];
  let cursor = 0;

  while (cursor < body.length) {
    const nextIf = findNextTopLevelIf(body, cursor);
    if (nextIf < 0) break;
    const conditionOpen = body.indexOf("(", nextIf);
    if (conditionOpen < 0) break;
    const conditionClose = findBalancedClose(body, conditionOpen, "(", ")");
    if (conditionClose < 0) break;
    const thenOpen = skipWhitespace(body, conditionClose + 1);
    if (body[thenOpen] !== "{") {
      cursor = conditionClose + 1;
      continue;
    }
    const thenClose = findBalancedClose(body, thenOpen, "{", "}");
    if (thenClose < 0) break;
    const afterThen = skipWhitespace(body, thenClose + 1);
    let elseBody = "";
    let afterElse = thenClose + 1;

    if (body.slice(afterThen, afterThen + 4) === "else") {
      const elseOpen = skipWhitespace(body, afterThen + 4);
      if (body[elseOpen] === "{") {
        const elseClose = findBalancedClose(body, elseOpen, "{", "}");
        if (elseClose >= 0) {
          elseBody = body.slice(elseOpen + 1, elseClose);
          afterElse = elseClose + 1;
        }
      }
    }

    blocks.push({
      condition: body.slice(conditionOpen + 1, conditionClose),
      thenBody: body.slice(thenOpen + 1, thenClose),
      elseBody
    });
    cursor = afterElse;
  }

  return blocks;
}

function findNextTopLevelIf(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && text.startsWith("if", index) && !/[A-Za-z0-9_$]/.test(text[index - 1] || "") && !/[A-Za-z0-9_$]/.test(text[index + 2] || "")) {
      return index;
    }
  }
  return -1;
}

function conditionLiteralValue(condition) {
  const contains = String(condition || "").match(/\.indexOf\(\s*(["'])([^"']+)\1\s*\)\s*(?:>=\s*0|>\s*-1|!==?\s*-1)/);
  if (contains) return contains[2];
  const equality = String(condition || "").match(/(?:^|[^\w$])[\w$]+\s*={2,3}\s*(["'])([^"']+)\1/);
  if (equality) return equality[2];
  const reversed = String(condition || "").match(/(["'])([^"']+)\1\s*={2,3}\s*[\w$]+/);
  return reversed?.[2] || "";
}

function extractDirectRowEffects(body) {
  const directBody = stripNestedBlocks(body);
  const effects = [];
  const seen = new Set();
  const pattern = /common_dom_row_set_show_required_reset\(\s*(["'])([^"']+)\1\s*,\s*(true|false)\s*,\s*(true|false)\s*,\s*(?:true|false)\s*\)/g;

  for (const match of directBody.matchAll(pattern)) {
    const target = match[2];
    const visible = match[3] === "true";
    const required = match[4] === "true";
    addEffect(effects, seen, { type: "visible", target, value: visible });
    addEffect(effects, seen, { type: "required", target, value: required });
  }

  return effects;
}

function stripNestedBlocks(text) {
  let output = "";
  let depth = 0;
  for (const char of String(text || "")) {
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) output += char;
  }
  return output;
}

function addEffect(effects, seen, effect) {
  const key = `${effect.type}:${effect.target}:${effect.value}`;
  if (seen.has(key)) return;
  seen.add(key);
  effects.push(effect);
}

function findBalancedClose(text, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = "";
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (char === quote && prev !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function skipWhitespace(text, index) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function stableIdPart(value) {
  return String(value || "value").replace(/[^A-Za-z0-9_.-]/g, "_");
}
