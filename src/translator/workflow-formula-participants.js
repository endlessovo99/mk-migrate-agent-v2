const FORMULA_PARTICIPANT_KEYS = Object.freeze([
  "mode",
  "fieldTitle",
  "subjectKind",
  "nodeId",
  "subjectExpression",
  "companyRole",
  "departmentRole",
  "sourceExpression",
  "sourceNameExpression"
]);

const FORMULA_SOURCE_ATTRIBUTE_KEYS = Object.freeze([
  "handlerSelectType",
  "handlerIds",
  "handlerNames"
]);

const FORMULA_PARTICIPANT_MODES = new Set([
  "unmapped_formula",
  "form_field",
  "person_by_login_name",
  "dept_leader_by_no",
  "doc_creator",
  "role_line"
]);

export function classifyWorkflowFormulaParticipant(attributes = {}) {
  if (attributes.handlerSelectType !== "formula") return undefined;

  const handlerIds = splitList(attributes.handlerIds);
  const handlerNames = splitList(attributes.handlerNames);
  return personByLoginNameParticipant(attributes, handlerIds, handlerNames) ||
    deptLeaderByNoParticipant(attributes, handlerIds, handlerNames) ||
    formFieldParticipant(attributes, handlerIds, handlerNames) ||
    roleLineParticipant(attributes, handlerIds, handlerNames) ||
    docCreatorParticipant(attributes, handlerIds, handlerNames) ||
    {
      mode: "unmapped_formula",
      reason: "source formula requires ES5 script translation",
      sourceExpression: attributes.handlerIds || "",
      sourceNameExpression: attributes.handlerNames || ""
    };
}

export function workflowFormulaParticipantMatches(attributes, participants) {
  const expected = classifyWorkflowFormulaParticipant(attributes);
  if (!expected || !participants || typeof participants !== "object") return false;
  const expectedSourceFieldId = expected.sourceFieldId || expected.fieldId;
  const actualSourceFieldId = participants.sourceFieldId || participants.fieldId;
  return expectedSourceFieldId === actualSourceFieldId &&
    FORMULA_PARTICIPANT_KEYS.every((key) => expected[key] === participants[key]);
}

export function inspectWorkflowFormulaProvenance(sourceDraft, dslDraft) {
  const sourceNodes = Array.isArray(sourceDraft?.workflow?.nodes) ? sourceDraft.workflow.nodes : [];
  const dslNodes = Array.isArray(dslDraft?.workflow?.nodes) ? dslDraft.workflow.nodes : [];
  const indexedDslNodes = dslNodes.map((node, nodeIndex) => ({ node, nodeIndex }));
  const inspections = [];
  const matchedDslIndexes = new Set();

  sourceNodes.forEach((sourceNode, sourceNodeIndex) => {
    const sourceAttributes = mergedAttributes(sourceNode);
    const sourceFormula = classifyWorkflowFormulaParticipant(sourceAttributes);
    if (!sourceFormula) return;

    const idMatches = indexedDslNodes.filter((entry) => entry.node?.id === sourceNode?.id);
    const refMatches = indexedDslNodes.filter((entry) => entry.node?.sourceRef === sourceNode?.sourceRef);
    const exactMatches = indexedDslNodes.filter((entry) =>
      entry.node?.id === sourceNode?.id && entry.node?.sourceRef === sourceNode?.sourceRef
    );
    const exact = exactMatches.length === 1 && idMatches.length === 1 && refMatches.length === 1
      ? exactMatches[0]
      : undefined;
    if (exact) matchedDslIndexes.add(exact.nodeIndex);

    const common = {
      nodeIndex: exact?.nodeIndex ?? idMatches[0]?.nodeIndex ?? sourceNodeIndex,
      sourceNodeIndex,
      nodeId: sourceNode?.id,
      sourceRef: sourceNode?.sourceRef,
      sourceExpression: sourceFormula.sourceExpression || sourceAttributes.handlerIds || "",
      expectedMode: sourceFormula.mode,
      actualMode: exact?.node?.participants?.mode
    };
    if (sourceFormula.mode === "unmapped_formula") {
      inspections.push({ ...common, status: "unmapped", identityMatched: Boolean(exact) });
    } else if (!exact) {
      inspections.push({ ...common, status: "source_missing_in_dsl", identityMatched: false });
    } else {
      const dslAttributes = mergedAttributes(exact.node);
      if (!formulaSourceAttributesMatch(sourceAttributes, dslAttributes)) {
        inspections.push({ ...common, status: "source_mismatch", identityMatched: true });
      } else if (
        !workflowFormulaParticipantMatches(sourceAttributes, exact.node?.participants) ||
        !workflowFormulaTargetFieldMatches(
          sourceFormula,
          exact.node?.participants,
          sourceDraft?.form,
          dslDraft?.form
        )
      ) {
        inspections.push({ ...common, status: "mapping_mismatch", identityMatched: true });
      } else {
        inspections.push({ ...common, status: "matched", identityMatched: true });
      }
    }
  });

  indexedDslNodes.forEach(({ node, nodeIndex }) => {
    if (matchedDslIndexes.has(nodeIndex)) return;
    const dslAttributes = mergedAttributes(node);
    const dslClaimsFormula = dslAttributes.handlerSelectType === "formula" ||
      FORMULA_PARTICIPANT_MODES.has(node?.participants?.mode);
    if (!dslClaimsFormula) return;
    inspections.push({
      status: "source_mismatch",
      nodeIndex,
      nodeId: node?.id,
      sourceRef: node?.sourceRef,
      sourceExpression: dslAttributes.handlerIds || node?.participants?.sourceExpression || "",
      actualMode: node?.participants?.mode,
      identityMatched: false
    });
  });

  return inspections;
}

function formFieldParticipant(attributes, handlerIds, handlerNames) {
  if (handlerIds.length !== 1) return undefined;

  const fieldId = simpleDollarExpressionValue(handlerIds[0]);
  if (!fieldId || !fieldId.startsWith("fd_")) return undefined;

  const fieldTitle = simpleDollarExpressionValue(handlerNames[0]) || fieldId;
  return {
    mode: "form_field",
    fieldId,
    sourceFieldId: fieldId,
    fieldTitle,
    sourceExpression: handlerIds[0],
    sourceNameExpression: handlerNames[0] || ""
  };
}

function docCreatorParticipant(attributes, handlerIds, handlerNames) {
  if (handlerIds.length !== 1) return undefined;

  const handlerId = simpleDollarExpressionValue(handlerIds[0]);
  if (!/^(docCreator|申请人|起草人|creator|drafter|initiator)$/i.test(handlerId)) return undefined;

  return {
    mode: "doc_creator",
    sourceExpression: handlerIds[0],
    sourceNameExpression: handlerNames[0] || handlerIds[0]
  };
}

function personByLoginNameParticipant(attributes, handlerIds, handlerNames) {
  return unaryFieldOrgFormulaParticipant(attributes, handlerIds, handlerNames, {
    mode: "person_by_login_name",
    parse: parsePersonByLoginNameFormula
  });
}

function deptLeaderByNoParticipant(attributes, handlerIds, handlerNames) {
  return unaryFieldOrgFormulaParticipant(attributes, handlerIds, handlerNames, {
    mode: "dept_leader_by_no",
    parse: parseDeptLeaderByNoFormula
  });
}

function unaryFieldOrgFormulaParticipant(attributes, handlerIds, handlerNames, options) {
  if (attributes.handlerSelectType !== "formula" || handlerIds.length !== 1) return undefined;

  const parsed = options.parse(handlerIds[0]);
  if (!parsed || !parsed.subject.startsWith("fd_")) return undefined;

  const nameParsed = options.parse(handlerNames[0]);
  const fieldTitle = nameParsed && nameParsed.subject && !nameParsed.subject.startsWith("fd_")
    ? nameParsed.subject
    : parsed.subject;

  return {
    mode: options.mode,
    fieldId: parsed.subject,
    sourceFieldId: parsed.subject,
    fieldTitle,
    sourceExpression: handlerIds[0],
    sourceNameExpression: handlerNames[0] || ""
  };
}

function roleLineParticipant(attributes, handlerIds, handlerNames) {
  if (attributes.handlerSelectType !== "formula" || handlerIds.length !== 1) return undefined;

  const parsed = parseRoleLineFormula(handlerIds[0]);
  if (!parsed) return undefined;

  const nameParsed = parseRoleLineFormula(handlerNames[0]);
  if (parsed.subjectKind === "node_handlers") {
    return {
      mode: "role_line",
      subjectKind: "node_handlers",
      nodeId: parsed.nodeId,
      subjectExpression: parsed.subjectExpression,
      companyRole: parsed.companyRole,
      departmentRole: parsed.departmentRole,
      sourceExpression: handlerIds[0],
      sourceNameExpression: handlerNames[0] || ""
    };
  }

  if (!parsed.subject.startsWith("fd_")) return undefined;
  const fieldTitle = nameParsed && nameParsed.subject && !String(nameParsed.subject).startsWith("fd_")
    ? nameParsed.subject
    : parsed.subject;

  return {
    mode: "role_line",
    subjectKind: "field",
    fieldId: parsed.subject,
    sourceFieldId: parsed.subject,
    fieldTitle,
    companyRole: parsed.companyRole,
    departmentRole: parsed.departmentRole,
    sourceExpression: handlerIds[0],
    sourceNameExpression: handlerNames[0] || ""
  };
}

function parseUnaryFieldOrgFormula(value, functionPattern) {
  const match = normalizeLegacyExpression(value).match(functionPattern);
  if (!match) return undefined;

  const args = splitFunctionArguments(match[1]);
  if (args.length !== 1) return undefined;

  const subject = simpleDollarExpressionValue(args[0]);
  return subject ? { subject } : undefined;
}

function parsePersonByLoginNameFormula(value) {
  return parseUnaryFieldOrgFormula(value, /^\$组织架构\.根据登录名取用户\$\s*\((.*)\)$/);
}

function parseDeptLeaderByNoFormula(value) {
  return parseUnaryFieldOrgFormula(value, /^\$部门领导\.根据部门编号获取部门领导\$\s*\((.*)\)$/);
}

function parseRoleLineFormula(value) {
  const match = normalizeLegacyExpression(value).match(/^\$组织架构\.解释角色线\$\s*\((.*)\)$/);
  if (!match) return undefined;

  const args = splitFunctionArguments(match[1]);
  if (args.length !== 3) return undefined;

  const subject = parseRoleLineSubject(args[0]);
  const companyRole = quotedLegacyArgument(args[1]);
  const departmentRole = quotedLegacyArgument(args[2]);
  if (!subject || !companyRole || !departmentRole) return undefined;

  return { ...subject, companyRole, departmentRole };
}

function parseRoleLineSubject(value) {
  const field = simpleDollarExpressionValue(value);
  if (field) return { subjectKind: "field", subject: field };

  const text = normalizeLegacyExpression(value);
  const match = text.match(/^\$流程\.获取节点实际处理人\$\s*\(\s*["']([^"']+)["']\s*\)$/);
  return match
    ? { subjectKind: "node_handlers", nodeId: match[1], subjectExpression: text }
    : undefined;
}

function splitFunctionArguments(value) {
  const args = [];
  const text = String(value || "");
  let quote = "";
  let depth = 0;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const previous = text[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  args.push(text.slice(start).trim());
  return args;
}

function quotedLegacyArgument(value) {
  const text = normalizeLegacyExpression(value);
  if (!/^"(?:\\.|[^"\\])*"$/.test(text) && !/^'(?:\\.|[^'\\])*'$/.test(text)) return undefined;
  const match = text.match(/^["']([\s\S]*)["']$/);
  return match ? match[1].replace(/\\"/g, "\"").replace(/\\'/g, "'") : text;
}

function simpleDollarExpressionValue(value) {
  const match = String(value || "").trim().match(/^\$([^$()]+)\$$/);
  return match ? match[1].trim() : "";
}

function normalizeLegacyExpression(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#36;/g, "$")
    .replace(/&amp;/g, "&")
    .trim();
}

function splitList(value) {
  return String(value || "").split(";").map((item) => item.trim()).filter(Boolean);
}

function mergedAttributes(node) {
  return {
    ...(node?.attributes && typeof node.attributes === "object" ? node.attributes : {}),
    ...(node?.definition?.attributes && typeof node.definition.attributes === "object"
      ? node.definition.attributes
      : {})
  };
}

function formulaSourceAttributesMatch(sourceAttributes, dslAttributes) {
  return FORMULA_SOURCE_ATTRIBUTE_KEYS.every((key) =>
    String(sourceAttributes[key] || "") === String(dslAttributes[key] || "")
  );
}

function workflowFormulaTargetFieldMatches(sourceFormula, participants, sourceForm, dslForm) {
  const sourceFieldId = sourceFormula?.sourceFieldId || sourceFormula?.fieldId;
  if (!sourceFieldId) return true;

  const sourceCandidates = [
    ...(sourceForm?.controls || []),
    ...(sourceForm?.dataFields || []),
    ...(sourceForm?.detailTables || []).flatMap((table) => [table, ...(table?.columns || [])])
  ].filter((field) => field?.id === sourceFieldId);
  const targetFields = (dslForm?.fields || []).flatMap((field) => [field, ...(field?.columns || [])]);
  const candidates = targetFields
    .filter((field) => field?.id === participants?.fieldId);
  if (sourceCandidates.length !== 1 || candidates.length !== 1) return false;
  const source = sourceCandidates[0];
  const target = candidates[0];
  const sourceRefCandidates = targetFields.filter((field) => field?.sourceRef === source.sourceRef);
  return (target.sourceProps?.originalId || target.id) === sourceFieldId &&
    target.sourceRef === source.sourceRef &&
    sourceRefCandidates.length === 1 &&
    sourceRefCandidates[0] === target;
}
