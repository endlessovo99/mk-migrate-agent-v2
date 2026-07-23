import { parse } from "acorn";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";

const BASIS = "deterministic-multi-radio-row-helper";
const ROW_HELPER = "common_dom_row_set_show_required_reset";
const HIDE_ALL = "hideAll";

export function multiRadioRowHelperFormRules(scripts = {}, form = {}) {
  const sources = Array.isArray(scripts?.sources) ? scripts.sources : [];
  for (const source of sources) {
    if (source.displayGate === "xform:viewShow") continue;
    const model = multiRadioRowHelperModel(source, scripts);
    if (!model || model.roles.readFromConFields) continue;
    if (!formAcceptsModel(form, model)) continue;
    const linkage = buildMultiRadioLinkageRules(model, source);
    if (!linkage.length) continue;
    return {
      linkage,
      validations: [],
      impliedRequired: [],
      review: {}
    };
  }
  return undefined;
}

export function multiRadioRowHelperCandidates(source = {}, form = {}, sourceScripts = {}) {
  const model = multiRadioRowHelperModel(source, sourceScripts);
  if (!model) return [];
  if (!formAcceptsModel(form, model)) return [];

  const sourceRef = source.sourceRef || source.id;
  const hideAllRef = model.hideAll.sourceRef;
  const sharedRefs = uniqueStrings([sourceRef, hideAllRef]);
  const sharedRanges = [
    {
      sourceRef: hideAllRef,
      name: HIDE_ALL,
      start: model.hideAll.start,
      end: model.hideAll.end
    },
    {
      sourceRef,
      name: model.judge.name,
      start: model.judge.start,
      end: model.judge.end
    }
  ];

  // Visibility/required land in formRules.linkage. Scripts only keep _con setValue
  // (editShow) or become a proven runtime noop (viewShow / helper-only).
  if (model.roles.readFromConFields || !model.judge.conFields.length) {
    return [buildOmittedCandidate({
      model,
      index: model.load?.index ?? model.judge.start,
      sourceRefs: sharedRefs,
      ranges: sharedRanges
    })];
  }

  const candidates = [];
  if (model.load) {
    candidates.push(buildCandidate({
      model,
      event: "onLoad",
      scope: "global",
      index: model.load.index,
      sourceRefs: sharedRefs,
      ranges: [
        ...sharedRanges,
        {
          sourceRef,
          name: "windowLoad",
          start: model.load.index,
          end: model.load.end
        }
      ],
      functionText: buildOnLoadFunction(model)
    }));
  }

  for (const binding of model.bindings) {
    candidates.push(buildCandidate({
      model,
      event: "onChange",
      scope: "control",
      controlId: binding.triggerId,
      index: binding.index,
      sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, binding.index),
      sourceRefs: sharedRefs,
      ranges: [
        ...sharedRanges,
        {
          sourceRef,
          name: `onChange:${binding.triggerId}`,
          start: binding.index,
          end: binding.end
        }
      ],
      functionText: buildOnChangeFunction(model, binding)
    }));
  }

  return candidates;
}

function buildCandidate({
  model,
  event,
  scope,
  controlId,
  index,
  sourceActionKey,
  sourceRefs,
  ranges,
  functionText
}) {
  return pruneUndefined({
    index,
    sourceActionKey,
    event,
    scope,
    controlId,
    javascript: model.sourceText,
    function: functionText,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "multi-radio hideAll/judgeMethod helper field sync",
      target: "native formRules.linkage + MKXFORM.setValue",
      basis: BASIS,
      reviewRequired: false
    }],
    sourceRefs,
    semanticHints: {
      coveredCalculationRanges: ranges
    }
  });
}

function buildOmittedCandidate({ model, index, sourceRefs, ranges }) {
  return {
    index,
    event: "onLoad",
    scope: "global",
    javascript: model.sourceText,
    function: "",
    translationStatus: "omitted",
    coverage: { status: "covered", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "multi-radio hideAll/judgeMethodView visibility owned by native formRules",
      target: "native formRules.linkage",
      basis: "legacy-runtime-noop",
      reviewRequired: false
    }],
    sourceRefs,
    semanticHints: {
      coveredCalculationRanges: ranges
    }
  };
}

function buildMultiRadioLinkageRules(model, source) {
  const sourceRef = source.sourceRef || source.id;
  const fieldByParam = {
    input1: model.roles.input1,
    input2: model.roles.input2,
    input3: model.roles.input3
  };
  const requiredOnShow = model.judge.requiredOnShow === true;
  const shownMarkers = uniqueStrings(
    model.judge.arms.flatMap((arm) => arm.effects.map((effect) => effect.target))
  );
  const orphanMarkers = model.hideAll.markers.filter((marker) => !shownMarkers.includes(marker));
  const baselineDeltaGroup = `multi-radio-row:${sourceRef}`;
  const linkage = [];

  model.judge.arms.forEach((arm, armIndex) => {
    const whenVariants = expandWhenVariants(arm.condition, fieldByParam);
    whenVariants.forEach((when, variantIndex) => {
      const sourceField = when[0]?.field;
      const effects = arm.effects.flatMap((effect) => rowEffects(effect.target, true, requiredOnShow));
      if (armIndex === 0 && orphanMarkers.length) {
        for (const marker of orphanMarkers) {
          effects.push(...rowEffects(marker, false, false));
        }
      }
      const elseEffects = arm.effects.flatMap((effect) => rowEffects(effect.target, false, false));
      if (armIndex === 0 && orphanMarkers.length) {
        for (const marker of orphanMarkers) {
          elseEffects.push(...rowEffects(marker, false, false));
        }
      }
      linkage.push({
        id: `linkage.multi-radio.${stableIdPart(sourceRef)}.arm${armIndex}${whenVariants.length > 1 ? `.v${variantIndex}` : ""}`,
        trigger: "change",
        source: sourceField,
        logic: "and",
        when,
        effects: dedupeEffects(effects),
        else: dedupeEffects(elseEffects),
        meta: {
          sourceJsp: sourceRef,
          baselineDeltaGroup,
          basis: BASIS
        },
        translationStatus: "executable"
      });
    });
  });

  const jjzlsj = model.load?.jjzlsj || model.bindings.find((binding) => binding.jjzlsj)?.jjzlsj;
  if (jjzlsj) {
    const fieldId = model.roles.input2;
    linkage.push({
      id: `linkage.multi-radio.${stableIdPart(sourceRef)}.jjzlsj`,
      trigger: "change",
      source: fieldId,
      logic: "and",
      when: [{
        field: fieldId,
        op: jjzlsj.useIndexOf ? "contains" : "eq",
        value: jjzlsj.value
      }],
      effects: rowEffects(jjzlsj.target, true, jjzlsj.requiredOnShow === true),
      else: rowEffects(jjzlsj.target, false, false),
      meta: {
        sourceJsp: sourceRef,
        basis: BASIS
      },
      translationStatus: "executable"
    });
  }

  return linkage;
}

function expandWhenVariants(condition, fieldByParam) {
  const when = [];
  for (const clause of condition || []) {
    const field = fieldByParam[clause.param];
    if (!field) return [];
    if (clause.op === "eq") {
      when.push({ field, op: "eq", value: clause.value });
      continue;
    }
    if (clause.op === "in") {
      when.push({ field, op: "in", value: clause.values || [] });
      continue;
    }
    return [];
  }
  return when.length ? [when] : [];
}

function rowEffects(target, visible, required) {
  return [
    { type: "visible", target, value: visible },
    { type: "required", target, value: required }
  ];
}

function dedupeEffects(effects = []) {
  const seen = new Set();
  const result = [];
  for (const effect of effects) {
    const key = `${effect.type}:${effect.target}:${effect.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(effect);
  }
  return result;
}

function stableIdPart(value) {
  return String(value || "")
    .replace(/^source\.form\.jsp\./, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "source";
}

function multiRadioRowHelperModel(source = {}, sourceScripts = {}) {
  const text = String(source.javascript || "");
  let program;
  try {
    program = parse(text, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return undefined;
  }

  const hideAll = findHideAll(source, sourceScripts);
  if (!hideAll) return undefined;

  const judge = findJudgeMethod(program, text);
  if (!judge) return undefined;

  const load = findLoadHandler(program, text, judge);
  const bindings = findValueChangeBindings(program, text, judge);
  if (!load && !bindings.length) return undefined;
  if (load && !loadAcceptable(load, judge)) return undefined;
  if (bindings.some((binding) => !bindingAcceptable(binding, judge))) return undefined;

  const roles = inferRadioRoles(load, bindings, judge);
  if (!roles) return undefined;

  return {
    sourceText: text,
    hideAll,
    judge,
    load,
    bindings,
    roles,
    mode: judge.requiredOnShow ? "edit" : "view"
  };
}

function findHideAll(source, sourceScripts) {
  const sources = [
    source,
    ...((sourceScripts?.sources || []).filter((candidate) => candidate !== source))
  ];
  for (const candidate of sources) {
    const text = String(candidate.javascript || "");
    let program;
    try {
      program = parse(text, { ecmaVersion: "latest", sourceType: "script" });
    } catch {
      continue;
    }
    const fn = program.body.find((statement) => (
      statement.type === "FunctionDeclaration" &&
      statement.id?.name === HIDE_ALL &&
      statement.params.length === 0
    ));
    if (!fn) continue;
    const markers = [];
    for (const statement of statementsOf(fn.body)) {
      const effect = rowEffectCall(statement.expression || statement);
      if (!effect || effect.visible !== false || effect.required !== false || effect.reset !== false) {
        return undefined;
      }
      markers.push(effect.target);
    }
    if (!markers.length) continue;
    return {
      sourceRef: candidate.sourceRef || candidate.id,
      start: fn.start,
      end: fn.end,
      markers: uniqueStrings(markers)
    };
  }
  return undefined;
}

function findJudgeMethod(program, text) {
  const fn = program.body.find((statement) => (
    statement.type === "FunctionDeclaration" &&
    ["judgeMethod", "judgeMethodView"].includes(statement.id?.name) &&
    statement.params.length === 3 &&
    statement.params.every((param) => param.type === "Identifier")
  ));
  if (!fn) return undefined;

  const params = fn.params.map((param) => param.name);
  const body = statementsOf(fn.body);
  if (body.length < 2) return undefined;

  let cursor = 0;
  const conFields = [];
  const declarations = [];
  while (cursor < body.length && declarations.length < 3) {
    const declaration = singleVarDeclaration(body[cursor]);
    const fieldId = declaration ? getXFormFieldByIdTarget(declaration.init) : undefined;
    if (!fieldId) break;
    declarations.push({ name: declaration.name, fieldId });
    cursor += 1;
  }
  if (declarations.length === 3) {
    for (let index = 0; index < 3; index += 1) {
      const assign = body[cursor];
      const expected = declarations[index];
      if (
        assign?.type !== "ExpressionStatement" ||
        assign.expression?.type !== "AssignmentExpression" ||
        assign.expression.operator !== "=" ||
        assign.expression.left?.type !== "MemberExpression" ||
        assign.expression.left.computed ||
        assign.expression.left.property?.name !== "value" ||
        assign.expression.left.object?.type !== "Identifier" ||
        assign.expression.left.object.name !== expected.name ||
        assign.expression.right?.type !== "Identifier" ||
        assign.expression.right.name !== params[index]
      ) {
        return undefined;
      }
      conFields.push(expected.fieldId);
      cursor += 1;
    }
  } else if (declarations.length !== 0) {
    return undefined;
  }

  const hideCall = body[cursor];
  if (!isHideAllCall(hideCall)) return undefined;
  cursor += 1;

  const arms = [];
  let requiredOnShow;
  while (cursor < body.length) {
    const statement = body[cursor];
    if (statement.type !== "IfStatement") return undefined;
    const chain = flattenIfElseChain(statement);
    if (!chain) return undefined;
    for (const branch of chain.branches) {
      const condition = parseJudgeCondition(branch.test, params);
      const effects = extractRowEffectsFromBlock(branch.body);
      if (!condition || !effects.length) return undefined;
      for (const effect of effects) {
        if (requiredOnShow === undefined) requiredOnShow = effect.required;
        if (effect.required !== requiredOnShow || effect.reset !== false) return undefined;
      }
      arms.push({ condition, effects });
    }
    if (chain.alternate) return undefined;
    cursor += 1;
    // Source uses a single if/else-if ladder; accept only one top-level chain.
    if (cursor < body.length) return undefined;
  }
  const writesConFields = conFields.length === 3;
  if (!arms.length) return undefined;
  if (fn.id.name === "judgeMethod" && !writesConFields) return undefined;
  if (fn.id.name === "judgeMethodView" && conFields.length !== 0) return undefined;

  return {
    name: fn.id.name,
    start: fn.start,
    end: fn.end,
    params,
    conFields,
    arms,
    requiredOnShow: requiredOnShow === true,
    writesConFields
  };
}

function findLoadHandler(program, text, judge) {
  for (const statement of program.body) {
    const call = statement.type === "ExpressionStatement" ? statement.expression : undefined;
    if (!isComAddWindowLoad(call)) continue;
    const listener = call.arguments[2];
    const timed = unwrapSetTimeoutCallback(listener);
    const callback = timed?.callback || listener;
    if (callback?.type !== "FunctionExpression" && callback?.type !== "ArrowFunctionExpression") {
      return undefined;
    }
    const body = statementsOf(callback.body);
    const interesting = body.filter((node) => !isConsoleLog(node));
    if (interesting.length < 2) return undefined;

    const reads = [];
    let offset = 0;
    while (offset < 3 && interesting[offset]) {
      const declaration = singleVarDeclaration(interesting[offset]);
      if (!declaration) break;
      const radioId = jqueryCheckedRadioId(declaration.init) ||
        getXFormFieldValueById(declaration.init);
      if (!radioId) break;
      reads.push({ name: declaration.name, fieldId: radioId });
      offset += 1;
    }
    if (reads.length !== 3) return undefined;

    const judgeCall = interesting[offset];
    const args = judgeCallArgs(judgeCall, judge.name);
    if (!args || args.length !== 3) return undefined;
    const argNames = args.map((argument) => (
      argument.type === "Identifier" ? argument.name : undefined
    ));
    if (argNames.some((name) => !name)) return undefined;
    const roleByParam = {};
    for (let index = 0; index < 3; index += 1) {
      const read = reads.find((item) => item.name === argNames[index]);
      if (!read) return undefined;
      roleByParam[judge.params[index]] = read.fieldId;
    }

    const jjzlsj = parseJjzlsjToggle(interesting.slice(offset + 1), argNames[1], judge.requiredOnShow);
    if (interesting.length !== offset + 1 + (jjzlsj ? 1 : 0)) return undefined;

    return {
      index: statement.start,
      end: statement.end,
      roleByParam,
      jjzlsj,
      readFromConFields: reads.every((read) => judge.conFields.includes(read.fieldId))
    };
  }
  return undefined;
}

function findValueChangeBindings(program, text, judge) {
  const bindings = [];
  for (const statement of program.body) {
    const call = statement.type === "ExpressionStatement" ? statement.expression : undefined;
    if (
      call?.type !== "CallExpression" ||
      call.callee?.type !== "Identifier" ||
      call.callee.name !== "AttachXFormValueChangeEventById" ||
      call.arguments?.length !== 2 ||
      call.arguments[0]?.type !== "Literal" ||
      typeof call.arguments[0].value !== "string"
    ) {
      continue;
    }
    const triggerId = call.arguments[0].value;
    const callback = call.arguments[1];
    if (callback?.type !== "FunctionExpression" && callback?.type !== "ArrowFunctionExpression") {
      return undefined;
    }
    if (callback.params?.[0]?.type !== "Identifier") return undefined;
    const valueName = callback.params[0].name;
    const body = statementsOf(callback.body).filter((node) => !isConsoleLog(node));

    const locals = new Map();
    let cursor = 0;
    while (cursor < body.length) {
      const declaration = singleVarDeclaration(body[cursor]);
      if (!declaration) break;
      if (declaration.init?.type === "Identifier" && declaration.init.name === valueName) {
        locals.set(declaration.name, { kind: "event" });
      } else {
        const radioId = jqueryCheckedRadioId(declaration.init);
        if (!radioId) return undefined;
        locals.set(declaration.name, { kind: "field", fieldId: radioId });
      }
      cursor += 1;
    }

    const judgeCall = body[cursor];
    const args = judgeCallArgs(judgeCall, judge.name);
    if (!args || args.length !== 3) return undefined;
    const roleByParam = {};
    for (let index = 0; index < 3; index += 1) {
      const argument = args[index];
      if (argument.type === "Identifier" && argument.name === valueName) {
        roleByParam[judge.params[index]] = { kind: "event", triggerId };
        continue;
      }
      if (argument.type === "Identifier" && locals.has(argument.name)) {
        const local = locals.get(argument.name);
        if (local.kind === "event") {
          roleByParam[judge.params[index]] = { kind: "event", triggerId };
        } else {
          roleByParam[judge.params[index]] = { kind: "field", fieldId: local.fieldId };
        }
        continue;
      }
      return undefined;
    }

    const remainder = body.slice(cursor + 1);
    const jjzlsj = parseJjzlsjToggle(
      remainder,
      valueName,
      judge.requiredOnShow,
      { allowIndexOf: true, eventName: valueName }
    );
    if (remainder.length !== (jjzlsj ? 1 : 0) && remainder.length !== (jjzlsj ? jjzlsj.statementCount : 0)) {
      // Accept either a single if/else or hide-then-if pattern counted by parser.
      if (!jjzlsj || remainder.length !== jjzlsj.statementCount) return undefined;
    }

    bindings.push({
      index: statement.start,
      end: statement.end,
      triggerId,
      roleByParam,
      jjzlsj
    });
  }
  return bindings;
}

function loadAcceptable(load, judge) {
  return judge.params.every((param) => nonEmptyString(load.roleByParam[param]));
}

function bindingAcceptable(binding, judge) {
  return judge.params.every((param) => binding.roleByParam[param]);
}

function inferRadioRoles(load, bindings, judge) {
  const roles = {
    input1: undefined,
    input2: undefined,
    input3: undefined,
    con1: judge.conFields[0],
    con2: judge.conFields[1],
    con3: judge.conFields[2],
    writesConFields: judge.writesConFields === true
  };
  const paramNames = judge.params;
  if (load && !load.readFromConFields) {
    roles.input1 = load.roleByParam[paramNames[0]];
    roles.input2 = load.roleByParam[paramNames[1]];
    roles.input3 = load.roleByParam[paramNames[2]];
  }
  for (const binding of bindings) {
    for (let index = 0; index < 3; index += 1) {
      const key = `input${index + 1}`;
      const role = binding.roleByParam[paramNames[index]];
      if (role.kind === "event") {
        if (roles[key] && roles[key] !== role.triggerId) return undefined;
        roles[key] = role.triggerId;
      } else if (role.kind === "field") {
        if (roles[key] && roles[key] !== role.fieldId) return undefined;
        roles[key] = role.fieldId;
      }
    }
  }
  if (load?.readFromConFields) {
    roles.input1 = roles.input1 || load.roleByParam[paramNames[0]];
    roles.input2 = roles.input2 || load.roleByParam[paramNames[1]];
    roles.input3 = roles.input3 || load.roleByParam[paramNames[2]];
    roles.readFromConFields = true;
  }
  if (![roles.input1, roles.input2, roles.input3].every(nonEmptyString)) return undefined;
  if (roles.writesConFields && ![roles.con1, roles.con2, roles.con3].every(nonEmptyString)) {
    return undefined;
  }
  return roles;
}

function formAcceptsModel(form, model) {
  const fieldIds = fieldIdSet(form);
  const markers = layoutMarkerSet(form);
  const neededFields = [
    model.roles.input1,
    model.roles.input2,
    model.roles.input3,
    ...(model.judge.conFields.length === 3
      ? [model.roles.con1, model.roles.con2, model.roles.con3]
      : [])
  ];
  if (neededFields.some((fieldId) => !fieldIds.has(fieldId))) return false;
  const neededMarkers = uniqueStrings([
    ...model.hideAll.markers,
    ...model.judge.arms.flatMap((arm) => arm.effects.map((effect) => effect.target)),
    ...(model.load?.jjzlsj ? [model.load.jjzlsj.target] : []),
    ...model.bindings.flatMap((binding) => binding.jjzlsj ? [binding.jjzlsj.target] : [])
  ]);
  return neededMarkers.every((marker) => markers.has(marker));
}

function buildOnLoadFunction(model) {
  const lines = ["function onLoad() {"];
  lines.push(`  var input1 = MKXFORM.getValue(${JSON.stringify(model.roles.input1)})`);
  lines.push(`  var input2 = MKXFORM.getValue(${JSON.stringify(model.roles.input2)})`);
  lines.push(`  var input3 = MKXFORM.getValue(${JSON.stringify(model.roles.input3)})`);
  if (model.judge.conFields.length === 3 && !model.roles.readFromConFields) {
    lines.push(...emitSetConValues(model));
  }
  lines.push("}");
  return lines.join("\n");
}

function buildOnChangeFunction(model, binding) {
  const lines = ["function onChange(value, rowNum, parentRowNum) {"];
  const names = {};
  for (let index = 0; index < 3; index += 1) {
    const param = model.judge.params[index];
    const role = binding.roleByParam[param];
    const varName = `input${index + 1}`;
    if (role.kind === "event") {
      lines.push(`  var ${varName} = value`);
      names[param] = varName;
    } else {
      const fieldId = role.fieldId;
      lines.push(`  var ${varName} = MKXFORM.getValue(${JSON.stringify(fieldId)})`);
      names[param] = varName;
    }
  }
  if (model.judge.conFields.length === 3) {
    lines.push(...emitSetConValues(model, names));
  }
  lines.push("}");
  return lines.join("\n");
}

function emitSetConValues(model, names = {
  [model.judge.params[0]]: "input1",
  [model.judge.params[1]]: "input2",
  [model.judge.params[2]]: "input3"
}) {
  return [
    `  MKXFORM.setValue(${JSON.stringify(model.roles.con1)}, ${names[model.judge.params[0]]})`,
    `  MKXFORM.setValue(${JSON.stringify(model.roles.con2)}, ${names[model.judge.params[1]]})`,
    `  MKXFORM.setValue(${JSON.stringify(model.roles.con3)}, ${names[model.judge.params[2]]})`
  ];
}

function emitHideAll(model) {
  const lines = [];
  for (const marker of model.hideAll.markers) {
    lines.push(`  MKXFORM.setFieldAttr(${JSON.stringify(marker)}, 4)`);
    lines.push(`  MKXFORM.setFieldAttr(${JSON.stringify(marker)}, 6)`);
  }
  return lines;
}

function emitJudgeArms(model, input1, input2, input3) {
  const lines = [];
  model.judge.arms.forEach((arm, index) => {
    const keyword = index === 0 ? "if" : "} else if";
    lines.push(`  ${keyword} (${renderCondition(arm.condition, input1, input2, input3)}) {`);
    for (const effect of arm.effects) {
      lines.push(...emitRowEffect(effect, model.judge.requiredOnShow));
    }
  });
  if (model.judge.arms.length) lines.push("  }");
  return lines;
}

function emitJjzlsjToggle(toggle, valueExpr, useIndexOf = false) {
  const showTest = useIndexOf
    ? `${valueExpr}.indexOf(${JSON.stringify(toggle.value)}) >= 0`
    : `${valueExpr} == ${JSON.stringify(toggle.value)}`;
  const lines = [
    `  if (${showTest}) {`,
    ...emitRowEffect({ target: toggle.target, visible: true, required: toggle.requiredOnShow }, toggle.requiredOnShow),
    "  } else {",
    ...emitRowEffect({ target: toggle.target, visible: false, required: false }, toggle.requiredOnShow),
    "  }"
  ];
  return lines;
}

function emitRowEffect(effect, requiredOnShow) {
  const lines = [];
  lines.push(`    MKXFORM.setFieldAttr(${JSON.stringify(effect.target)}, ${effect.visible ? 5 : 4})`);
  if (requiredOnShow) {
    lines.push(`    MKXFORM.setFieldAttr(${JSON.stringify(effect.target)}, ${effect.required ? 3 : 6})`);
  } else {
    lines.push(`    MKXFORM.setFieldAttr(${JSON.stringify(effect.target)}, 6)`);
  }
  return lines;
}

function renderCondition(condition, input1, input2, input3) {
  const parts = [];
  for (const clause of condition) {
    const name = clause.param === "input1" ? input1 : clause.param === "input2" ? input2 : input3;
    if (clause.op === "eq") {
      parts.push(`${name} == ${JSON.stringify(clause.value)}`);
    } else if (clause.op === "in") {
      const options = clause.values.map((value) => `${name} == ${JSON.stringify(value)}`);
      parts.push(options.length === 1 ? options[0] : `(${options.join(" || ")})`);
    }
  }
  return parts.join(" && ");
}

function parseJudgeCondition(test, params) {
  const clauses = flattenAnd(test);
  if (!clauses.length) return undefined;
  const mapped = [];
  for (const clause of clauses) {
    if (clause.type === "BinaryExpression" && ["==", "==="].includes(clause.operator)) {
      const left = clause.left.type === "Identifier" ? clause.left.name : undefined;
      const right = clause.right.type === "Literal" && typeof clause.right.value === "string"
        ? clause.right.value
        : undefined;
      const paramIndex = params.indexOf(left);
      if (paramIndex < 0 || right === undefined) return undefined;
      mapped.push({ param: `input${paramIndex + 1}`, op: "eq", value: right });
      continue;
    }
    if (clause.type === "LogicalExpression" && clause.operator === "||") {
      const options = flattenOr(clause);
      if (!options.length) return undefined;
      let paramIndex = -1;
      const values = [];
      for (const option of options) {
        if (option.type !== "BinaryExpression" || !["==", "==="].includes(option.operator)) {
          return undefined;
        }
        const left = option.left.type === "Identifier" ? option.left.name : undefined;
        const right = option.right.type === "Literal" && typeof option.right.value === "string"
          ? option.right.value
          : undefined;
        const index = params.indexOf(left);
        if (index < 0 || right === undefined) return undefined;
        if (paramIndex === -1) paramIndex = index;
        if (paramIndex !== index) return undefined;
        values.push(right);
      }
      mapped.push({ param: `input${paramIndex + 1}`, op: "in", values: uniqueStrings(values) });
      continue;
    }
    return undefined;
  }
  return mapped;
}

function parseJjzlsjToggle(statements, compareName, requiredOnShow, options = {}) {
  if (!statements.length) return undefined;
  if (statements.length === 1 && statements[0].type === "IfStatement") {
    const chain = flattenIfElseChain(statements[0]);
    if (!chain || chain.branches.length !== 1 || !chain.alternate) return undefined;
    const test = chain.branches[0].test;
    const value = equalityValueAgainst(test, compareName) ||
      (options.allowIndexOf ? indexOfValueAgainst(test, options.eventName || compareName) : undefined);
    if (!value) return undefined;
    const showEffects = extractRowEffectsFromBlock(chain.branches[0].body);
    const hideEffects = extractRowEffectsFromBlock(chain.alternate);
    if (showEffects.length !== 1 || hideEffects.length !== 1) return undefined;
    if (showEffects[0].target !== hideEffects[0].target) return undefined;
    if (showEffects[0].visible !== true || hideEffects[0].visible !== false) return undefined;
    if (hideEffects[0].required !== false || hideEffects[0].reset !== false) return undefined;
    if (showEffects[0].required !== requiredOnShow || showEffects[0].reset !== false) return undefined;
    return {
      target: showEffects[0].target,
      value,
      requiredOnShow,
      useIndexOf: Boolean(indexOfValueAgainst(test, options.eventName || compareName)),
      statementCount: 1
    };
  }

  // hide-then-if pattern used by onChange of event category
  if (statements.length === 2) {
    const hide = rowEffectCall(statements[0].expression || statements[0]);
    if (!hide || hide.visible !== false || hide.required !== false || hide.reset !== false) {
      return undefined;
    }
    if (statements[1].type !== "IfStatement" || statements[1].alternate) return undefined;
    const value = options.allowIndexOf
      ? indexOfValueAgainst(statements[1].test, options.eventName || compareName)
      : equalityValueAgainst(statements[1].test, compareName);
    if (!value) return undefined;
    const showEffects = extractRowEffectsFromBlock(statements[1].consequent);
    if (showEffects.length !== 1 || showEffects[0].target !== hide.target) return undefined;
    if (showEffects[0].visible !== true || showEffects[0].required !== requiredOnShow) return undefined;
    return {
      target: hide.target,
      value,
      requiredOnShow,
      useIndexOf: true,
      statementCount: 2
    };
  }
  return undefined;
}

function extractRowEffectsFromBlock(block) {
  const statements = statementsOf(block);
  const effects = [];
  for (const statement of statements) {
    const effect = rowEffectCall(statement.expression || statement);
    if (!effect) return [];
    effects.push(effect);
  }
  return effects;
}

function rowEffectCall(node) {
  const call = node?.type === "ExpressionStatement" ? node.expression : node;
  if (
    call?.type !== "CallExpression" ||
    call.callee?.type !== "Identifier" ||
    call.callee.name !== ROW_HELPER ||
    call.arguments?.length !== 4 ||
    call.arguments[0]?.type !== "Literal" ||
    typeof call.arguments[0].value !== "string" ||
    call.arguments[1]?.type !== "Literal" ||
    typeof call.arguments[1].value !== "boolean" ||
    call.arguments[2]?.type !== "Literal" ||
    typeof call.arguments[2].value !== "boolean" ||
    call.arguments[3]?.type !== "Literal" ||
    typeof call.arguments[3].value !== "boolean"
  ) {
    return undefined;
  }
  return {
    target: call.arguments[0].value,
    visible: call.arguments[1].value,
    required: call.arguments[2].value,
    reset: call.arguments[3].value
  };
}

function isHideAllCall(statement) {
  const call = statement?.type === "ExpressionStatement" ? statement.expression : statement;
  return call?.type === "CallExpression" &&
    call.callee?.type === "Identifier" &&
    call.callee.name === HIDE_ALL &&
    (call.arguments?.length || 0) === 0;
}

function isComAddWindowLoad(call) {
  return call?.type === "CallExpression" &&
    call.callee?.type === "Identifier" &&
    call.callee.name === "Com_AddEventListener" &&
    call.arguments?.length === 3 &&
    call.arguments[0]?.type === "Identifier" &&
    call.arguments[0].name === "window" &&
    call.arguments[1]?.type === "Literal" &&
    call.arguments[1].value === "load";
}

function unwrapSetTimeoutCallback(listener) {
  if (listener?.type !== "FunctionExpression" && listener?.type !== "ArrowFunctionExpression") {
    return undefined;
  }
  const body = statementsOf(listener.body);
  if (body.length !== 1 || body[0].type !== "ExpressionStatement") return undefined;
  const call = body[0].expression;
  if (
    call?.type !== "CallExpression" ||
    call.callee?.type !== "Identifier" ||
    call.callee.name !== "setTimeout" ||
    call.arguments?.length < 1
  ) {
    return undefined;
  }
  return { callback: call.arguments[0] };
}

function judgeCallArgs(statement, judgeName) {
  const call = statement?.type === "ExpressionStatement" ? statement.expression : statement;
  if (
    call?.type !== "CallExpression" ||
    call.callee?.type !== "Identifier" ||
    call.callee.name !== judgeName
  ) {
    return undefined;
  }
  return call.arguments || [];
}

function jqueryCheckedRadioId(node) {
  if (
    node?.type !== "CallExpression" ||
    node.callee?.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.property?.name !== "val" ||
    node.callee.object?.type !== "CallExpression" ||
    node.callee.object.callee?.type !== "Identifier" ||
    node.callee.object.callee.name !== "$" ||
    node.callee.object.arguments?.length !== 1 ||
    node.callee.object.arguments[0]?.type !== "Literal" ||
    typeof node.callee.object.arguments[0].value !== "string"
  ) {
    return undefined;
  }
  const selector = node.callee.object.arguments[0].value;
  const match = selector.match(
    /^\s*\[\s*name\s*=\s*["']?extendDataFormInfo\.value\(\s*([A-Za-z0-9_.-]+)\s*\)["']?\s*\]\s*(?::checked)?\s*$/
  );
  return match?.[1];
}

function getXFormFieldByIdTarget(node) {
  if (
    node?.type !== "MemberExpression" ||
    !node.computed ||
    node.property?.type !== "Literal" ||
    node.property.value !== 0 ||
    node.object?.type !== "CallExpression" ||
    node.object.callee?.type !== "Identifier" ||
    node.object.callee.name !== "GetXFormFieldById" ||
    node.object.arguments?.length !== 1 ||
    node.object.arguments[0]?.type !== "Literal" ||
    typeof node.object.arguments[0].value !== "string"
  ) {
    return undefined;
  }
  return node.object.arguments[0].value;
}

function getXFormFieldValueById(node) {
  if (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.property?.name === "value"
  ) {
    return getXFormFieldByIdTarget(node.object);
  }
  return undefined;
}

function equalityValueAgainst(test, name) {
  if (test?.type !== "BinaryExpression" || !["==", "==="].includes(test.operator)) return undefined;
  if (test.left?.type === "Identifier" && test.left.name === name && test.right?.type === "Literal") {
    return typeof test.right.value === "string" ? test.right.value : undefined;
  }
  if (test.right?.type === "Identifier" && test.right.name === name && test.left?.type === "Literal") {
    return typeof test.left.value === "string" ? test.left.value : undefined;
  }
  return undefined;
}

function indexOfValueAgainst(test, name) {
  if (
    test?.type !== "BinaryExpression" ||
    ![">=", ">"].includes(test.operator) ||
    test.left?.type !== "CallExpression" ||
    test.left.callee?.type !== "MemberExpression" ||
    test.left.callee.computed ||
    test.left.callee.property?.name !== "indexOf" ||
    test.left.callee.object?.type !== "Identifier" ||
    test.left.callee.object.name !== name ||
    test.left.arguments?.length !== 1 ||
    test.left.arguments[0]?.type !== "Literal" ||
    typeof test.left.arguments[0].value !== "string" ||
    test.right?.type !== "Literal"
  ) {
    return undefined;
  }
  if (test.operator === ">=" && test.right.value === 0) return test.left.arguments[0].value;
  if (test.operator === ">" && test.right.value === -1) return test.left.arguments[0].value;
  return undefined;
}

function flattenIfElseChain(statement) {
  const branches = [];
  let current = statement;
  while (current?.type === "IfStatement") {
    branches.push({ test: current.test, body: current.consequent });
    if (!current.alternate) return { branches, alternate: undefined };
    if (current.alternate.type === "IfStatement") {
      current = current.alternate;
      continue;
    }
    return { branches, alternate: current.alternate };
  }
  return undefined;
}

function flattenAnd(node) {
  if (node?.type === "LogicalExpression" && node.operator === "&&") {
    return [...flattenAnd(node.left), ...flattenAnd(node.right)];
  }
  return node ? [node] : [];
}

function flattenOr(node) {
  if (node?.type === "LogicalExpression" && node.operator === "||") {
    return [...flattenOr(node.left), ...flattenOr(node.right)];
  }
  return node ? [node] : [];
}

function statementsOf(block) {
  if (!block) return [];
  if (block.type === "BlockStatement") {
    return block.body.filter((statement) => statement.type !== "EmptyStatement");
  }
  return [block];
}

function singleVarDeclaration(statement) {
  if (
    statement?.type !== "VariableDeclaration" ||
    statement.declarations?.length !== 1 ||
    statement.declarations[0].id?.type !== "Identifier"
  ) {
    return undefined;
  }
  return {
    name: statement.declarations[0].id.name,
    init: statement.declarations[0].init
  };
}

function isConsoleLog(statement) {
  const call = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  return call?.type === "CallExpression" &&
    call.callee?.type === "MemberExpression" &&
    !call.callee.computed &&
    call.callee.object?.type === "Identifier" &&
    call.callee.object.name === "console" &&
    ["log", "debug", "info", "warn", "error"].includes(call.callee.property?.name);
}

function fieldIdSet(form) {
  return new Set(
    (Array.isArray(form?.fields) ? form.fields : [])
      .map((field) => field?.id)
      .filter(nonEmptyString)
  );
}

function layoutMarkerSet(form) {
  const markers = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.sourceMarkers)) {
      node.sourceMarkers.filter(nonEmptyString).forEach((marker) => markers.add(marker));
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(form?.layout);
  return markers;
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(nonEmptyString))];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function pruneUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
