export function sourceFormRulesFromLegacyScripts(scripts) {
  const sources = Array.isArray(scripts?.sources) ? scripts.sources : [];
  const linkageById = new Map();

  for (const source of sources) {
    if (source.displayGate === "xform:viewShow") continue;
    for (const rule of analyzeLegacyScriptFormRules(source).linkage) {
      mergeLinkageRule(linkageById, rule);
    }
  }

  const linkage = [...linkageById.values()];
  if (!linkage.length) return undefined;
  return {
    linkage,
    validations: [],
    impliedRequired: [],
    review: {}
  };
}

export function analyzeLegacyScriptFormRules(source) {
  const javascript = source?.javascript || "";
  const callbacks = extractXFormValueChangeCallbacks(javascript);
  const linkageById = new Map();

  for (const callback of callbacks) {
    for (const block of extractTopLevelIfElseBlocks(callback.body)) {
      const condition = conditionSpec(block.condition, callback.source);
      if (!condition) continue;

      const effects = extractDirectRowEffects(block.thenBody);
      const elseEffects = extractDirectRowEffects(block.elseBody);
      if (!effects.length || !elseEffects.length) continue;

      mergeLinkageRule(linkageById, {
        id: `linkage.${callback.source}.${condition.idPart}`,
        trigger: "change",
        source: callback.source,
        logic: condition.logic,
        when: condition.when,
        effects,
        else: elseEffects,
        meta: pruneUndefined({
          sourceJsp: source.sourceRef,
          displayGate: source.displayGate,
          runWhen: runWhenFromDisplayGate(source.displayGate)
        }),
        translationStatus: "executable"
      });
    }
  }

  return {
    linkage: [...linkageById.values()],
    residuals: extractScriptResiduals(source)
  };
}

function mergeLinkageRule(linkageById, rule) {
  const existing = linkageById.get(rule.id);
  if (!existing) {
    linkageById.set(rule.id, {
      ...rule,
      effects: dedupeEffects(rule.effects),
      else: dedupeEffects(rule.else)
    });
    return;
  }

  existing.effects = mergeEffects(existing.effects, rule.effects);
  existing.else = mergeEffects(existing.else, rule.else);
  existing.meta = mergeRuleMeta(existing.meta, rule.meta);
}

function mergeRuleMeta(left = {}, right = {}) {
  const sourceJsps = uniqueStrings([
    left.sourceJsp,
    ...(left.sourceJsps || []),
    right.sourceJsp,
    ...(right.sourceJsps || [])
  ]);
  return {
    ...left,
    ...right,
    sourceJsp: left.sourceJsp || right.sourceJsp,
    sourceJsps: sourceJsps.length > 1 ? sourceJsps : undefined
  };
}

function mergeEffects(left = [], right = []) {
  return dedupeEffects([...(left || []), ...(right || [])]);
}

function dedupeEffects(effects = []) {
  const result = [];
  const seen = new Set();
  for (const effect of effects || []) {
    addEffect(result, seen, effect);
  }
  return result;
}

function extractScriptResiduals(source = {}) {
  const javascript = source.javascript || "";
  return [
    ...extractFieldValueAssignmentResiduals(javascript, source),
    ...extractUnsupportedEventResiduals(javascript, source)
  ];
}

function extractFieldValueAssignmentResiduals(javascript, source) {
  const text = String(javascript || "");
  const events = [];
  const declarations = /(?:^|[^\w$])(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*GetXFormFieldById\(\s*(["'])([^"']+)\2\s*\)(?:\s*\[\s*0\s*\])?/g;
  for (const match of text.matchAll(declarations)) {
    events.push({
      kind: "declaration",
      index: match.index,
      variable: match[1],
      target: match[3]
    });
  }
  const assignments = /([A-Za-z_$][\w$]*)(?:\s*\[\s*0\s*\])?\s*\.\s*value\s*=\s*([^;\n]+)/g;
  for (const match of text.matchAll(assignments)) {
    events.push({
      kind: "assignment",
      index: match.index,
      variable: match[1],
      evidence: match[0]
    });
  }
  events.sort((left, right) => left.index - right.index);

  const variables = new Map();
  const residuals = [];
  for (const event of events) {
    if (event.kind === "declaration") {
      variables.set(event.variable, event.target);
      continue;
    }
    const target = variables.get(event.variable);
    if (!target) continue;
    residuals.push(residual({
      code: "script.residual.field_value_assignment",
      type: "fieldValueAssignment",
      message: `Field value assignment for ${target} is not represented by native formRules.`,
      sourceRef: source.sourceRef,
      target,
      evidence: oneLine(event.evidence)
    }));
  }
  return residuals;
}

function extractUnsupportedEventResiduals(javascript, source) {
  const residuals = [];
  const text = String(javascript || "");
  const namedValueChange = /AttachXFormValueChangeEventById\(\s*(["'])([^"']+)\1\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  for (const match of text.matchAll(namedValueChange)) {
    residuals.push(residual({
      code: "script.residual.named_value_change_callback",
      type: "namedValueChangeCallback",
      message: `Named value-change callback ${match[3]} for ${match[2]} requires manual script translation.`,
      sourceRef: source.sourceRef,
      trigger: match[2],
      callback: match[3],
      evidence: oneLine(match[0])
    }));
  }

  const loadListener = /Com_AddEventListener\(\s*window\s*,\s*(["'])load\1/g;
  for (const match of text.matchAll(loadListener)) {
    residuals.push(residual({
      code: "script.residual.window_load_listener",
      type: "windowLoadListener",
      message: "Window load listener is not represented by native formRules.",
      sourceRef: source.sourceRef,
      evidence: oneLine(text.slice(match.index, Math.min(text.length, match.index + 160)))
    }));
  }
  return residuals;
}

function residual(input) {
  return pruneUndefined({
    code: input.code,
    type: input.type,
    message: input.message,
    sourceRef: input.sourceRef,
    target: input.target,
    trigger: input.trigger,
    callback: input.callback,
    evidence: input.evidence
  });
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

function conditionSpec(condition, field) {
  const text = String(condition || "");
  const regexTest = text.match(/\/\[([^\]]+)\]\/[gimsuy]*\.test\(\s*[A-Za-z_$][\w$]*\s*\)/);
  if (regexTest && /^[A-Za-z0-9]+$/.test(regexTest[1])) {
    const values = uniqueStrings([...regexTest[1]]);
    return {
      idPart: `eq.${values.map(stableIdPart).join("_")}`,
      logic: values.length > 1 ? "or" : "and",
      when: values.map((value) => ({ field, op: "eq", value }))
    };
  }

  const contains = text.match(/\.indexOf\(\s*(["'])([^"']+)\1\s*\)\s*(?:>=\s*0|>\s*-1|!==?\s*-1)/);
  if (contains) {
    return {
      idPart: `contains.${stableIdPart(contains[2])}`,
      logic: "and",
      when: [{ field, op: "contains", value: contains[2] }]
    };
  }

  const equality = text.match(/(?:^|[^\w$])[\w$]+\s*={2,3}\s*(["'])([^"']+)\1/);
  const reversed = text.match(/(["'])([^"']+)\1\s*={2,3}\s*[\w$]+/);
  const value = equality?.[2] || reversed?.[2];
  if (!value) return undefined;
  return {
    idPart: `eq.${stableIdPart(value)}`,
    logic: "and",
    when: [{ field, op: "eq", value }]
  };
}

function runWhenFromDisplayGate(displayGate) {
  if (displayGate === "xform:editShow") return { viewStatusIn: ["add", "edit"] };
  if (displayGate === "xform:viewShow") return { viewStatusIn: ["view"] };
  return undefined;
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

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function oneLine(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, pruneUndefined(child)])
  );
}
