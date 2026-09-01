import { createHash } from "node:crypto";

import { preparePersistedTemplate } from "./persistence.js";
import { stableStringify } from "./persistence/normalize.js";
import { withoutMechanismTokens } from "./published-form-patch.js";

const AUTHORIZATION_COLLECTIONS = Object.freeze([
  "readers",
  "editors",
  "allReaders",
  "allEditors",
  "temporaryReaders",
  "temporaryEditors"
]);
const AUTHORIZATION_NATIVE_FIELDS = Object.freeze({
  readers: "fdReaders",
  editors: "fdEditors",
  allReaders: "fdAllReaders",
  allEditors: "fdAllEditors",
  temporaryReaders: "fdTmpReaders",
  temporaryEditors: "fdTmpEditors"
});

export async function prepareLockedDraftRepair({ client, before, dsl, sourceDsl, priorExecutionReport, repairKind, envelope }) {
  if (repairKind === "template_authorization") {
    return prepareAuthorizationRepair({
      client,
      before,
      dsl,
      sourceDsl,
      priorExecutionReport
    });
  }
  if (repairKind === "calculation") {
    return prepareCalculationRepair({ before, dsl, priorExecutionReport, envelope });
  }
  throw coded("locked_draft.repair_kind_unsupported");
}

async function prepareAuthorizationRepair({ client, before, sourceDsl, priorExecutionReport }) {
  const mismatch = (priorExecutionReport.diagnostics || []).filter((diagnostic) => (
    diagnostic?.level === "error" &&
    diagnostic?.code === "readback.workflow.template_authorization_mismatch"
  ));
  requireValue(mismatch.length === 1, "locked_draft.authorization_evidence_required");
  const expected = mismatch[0].details?.expected;
  const actual = mismatch[0].details?.actual;
  requireValue(expected && actual, "locked_draft.authorization_evidence_required");
  const observed = observedAuthorization(before.template);
  for (const collection of AUTHORIZATION_COLLECTIONS) {
    requireValue(
      stableStringify(observed[collection]) === stableStringify(sortedIds(actual[collection])),
      "locked_draft.authorization_snapshot_mismatch"
    );
  }

  const desiredEditors = unionIds(expected.editors, expected.allEditors);
  const editorIds = new Set(desiredEditors);
  const desiredReaders = unionIds(
    expected.readers,
    (expected.allReaders || []).filter((id) => !editorIds.has(id))
  );
  const desired = {
    readers: desiredReaders,
    editors: desiredEditors,
    allReaders: sortedIds(expected.allReaders),
    allEditors: sortedIds(expected.allEditors),
    temporaryReaders: sortedIds(expected.temporaryReaders),
    temporaryEditors: sortedIds(expected.temporaryEditors)
  };
  const missingIds = [...new Set(
    AUTHORIZATION_COLLECTIONS.flatMap((collection) => (
      desired[collection].filter((id) => !observed[collection].includes(id))
    ))
  )].sort();
  requireValue(missingIds.length > 0, "locked_draft.authorization_no_change");
  const elements = await client.getElementInfo(missingIds);
  const elementById = new Map((elements || []).map((member) => [member?.fdId, member]));
  for (const id of missingIds) {
    const sourceMember = sourceAuthorizationMember(sourceDsl, id);
    const target = elementById.get(id);
    requireValue(
      target?.fdId === id && text(target.fdName) &&
        Number(target.fdOrgType) === Number(sourceMember?.sourceOrgType),
      "locked_draft.authorization_identity_mismatch"
    );
  }

  const template = structuredClone(before.template);
  for (const collection of AUTHORIZATION_COLLECTIONS) {
    const nativeField = AUTHORIZATION_NATIVE_FIELDS[collection];
    template[nativeField] = membersForIds(
      desired[collection],
      before.template[nativeField],
      elementById
    );
  }
  template.mechanisms.lbpmTemplate[0].fdReaders = structuredClone(template.fdReaders);
  template.mechanisms.lbpmTemplate[0].fdEditors = structuredClone(template.fdEditors);
  const workflow = structuredClone(before.workflow);
  workflow.fdReaders = structuredClone(template.fdReaders);
  workflow.fdEditors = structuredClone(template.fdEditors);

  const changedPaths = authorizationChangedPaths(before, { template, workflow });
  const allowedPaths = [
    "/fdAllEditors",
    "/fdAllReaders",
    "/fdEditors",
    "/mechanisms/lbpmTemplate/0/fdEditors",
    "/workflowDetail/fdEditors"
  ];
  requireValue(
    stableStringify(changedPaths) === stableStringify(allowedPaths),
    "locked_draft.authorization_delta_outside_scope"
  );
  requireValue(
    digest(protectedAuthorizationBundle(before)) ===
      digest(protectedAuthorizationBundle({ template, workflow })),
    "locked_draft.authorization_delta_outside_scope"
  );

  return {
    before,
    template,
    workflow,
    plan: {
      repairKind: "template_authorization",
      targetTemplateId: template.fdId,
      missingIds,
      changedPaths
    },
    verify(after) {
      const afterObserved = observedAuthorization(after.template);
      const authorizationOk = AUTHORIZATION_COLLECTIONS.every((collection) => (
        stableStringify(afterObserved[collection]) === stableStringify(desired[collection])
      ));
      const bindingsOk = stableStringify(ids(after.template.mechanisms.lbpmTemplate[0].fdReaders)) ===
          stableStringify(desired.readers) &&
        stableStringify(ids(after.template.mechanisms.lbpmTemplate[0].fdEditors)) ===
          stableStringify(desired.editors) &&
        stableStringify(ids(after.workflow?.fdReaders)) === stableStringify(desired.readers) &&
        stableStringify(ids(after.workflow?.fdEditors)) === stableStringify(desired.editors);
      const protectedOk = digest(protectedAuthorizationBundle(before)) ===
        digest(protectedAuthorizationBundle(after));
      return {
        ok: authorizationOk && bindingsOk && protectedOk,
        checks: { authorizationOk, bindingsOk, protectedOk }
      };
    }
  };
}

function prepareCalculationRepair({ before, dsl, priorExecutionReport, envelope }) {
  const calculationDiagnostics = (priorExecutionReport.diagnostics || []).filter((diagnostic) => (
    diagnostic?.level === "error" && [
      "readback.form.calculation_order_mismatch",
      "readback.form.prop_calculation_mismatch"
    ].includes(diagnostic.code)
  ));
  requireValue(
    calculationDiagnostics.length === 2 &&
      calculationDiagnostics.some((diagnostic) => diagnostic.code === "readback.form.calculation_order_mismatch") &&
      calculationDiagnostics.some((diagnostic) => diagnostic.code === "readback.form.prop_calculation_mismatch"),
    "locked_draft.calculation_evidence_required"
  );
  const propMismatch = calculationDiagnostics.find((diagnostic) => (
    diagnostic.code === "readback.form.prop_calculation_mismatch"
  ));
  const aggregateFieldId = text(propMismatch?.details?.fieldId);
  const aggregateField = findDslField(dsl, aggregateFieldId);
  const aggregate = aggregateField?.props?.calculation;
  requireValue(
    aggregate?.kind === "aggregate" && aggregate.operation === "sum" &&
      text(aggregate.tableId) && text(aggregate.fieldId),
    "locked_draft.calculation_dsl_mismatch"
  );
  const detailTable = (dsl.form?.fields || []).find((field) => (
    field?.type === "detailTable" && field.id === aggregate.tableId
  ));
  const rowField = detailTable?.columns?.find((field) => field.id === aggregate.fieldId);
  requireValue(rowField?.props?.calculation?.kind === "formula", "locked_draft.calculation_row_formula_required");

  const projection = preparePersistedTemplate({
    dsl,
    envelope,
    baseTemplate: before.template
  });
  requireValue(projection.ok, "locked_draft.calculation_projection_failed");
  const candidateConfig = parsedXformConfig(projection.update);
  const currentConfig = parsedXformConfig(before.template);
  const nextConfig = structuredClone(currentConfig);

  const candidateFormAttr = parsedFormAttr(candidateConfig);
  const currentFormAttr = parsedFormAttr(currentConfig);
  const orderMismatch = calculationDiagnostics.find((diagnostic) => (
    diagnostic.code === "readback.form.calculation_order_mismatch"
  ));
  requireValue(
    stableStringify(orderMismatch?.details?.actual || []) === "[]" &&
      stableStringify(currentFormAttr.formRule?.compute || []) === "[]",
    "locked_draft.calculation_snapshot_mismatch"
  );
  const currentRowAttribute = parsedNativeAttribute(
    nativeDetailField(currentConfig, aggregate.tableId, aggregate.fieldId)
  );
  const signKey = `${aggregate.fieldId}.expressionFormulaVO`;
  requireValue(
    currentRowAttribute.config?.controlProps?.expressionFormulaVO === undefined &&
      currentConfig.sign?.formula?.[signKey] === undefined,
    "locked_draft.calculation_snapshot_mismatch"
  );
  const nextFormAttr = parsedFormAttr(nextConfig);
  requireValue(
    Array.isArray(candidateFormAttr.formRule?.compute) &&
      candidateFormAttr.formRule.compute.length > 0,
    "locked_draft.calculation_compute_required"
  );
  nextFormAttr.formRule = nextFormAttr.formRule || {};
  nextFormAttr.formRule.compute = structuredClone(candidateFormAttr.formRule.compute);
  nextConfig.attribute.formAttr = JSON.stringify(nextFormAttr);

  const candidateRow = nativeDetailField(candidateConfig, aggregate.tableId, aggregate.fieldId);
  const nextRow = nativeDetailField(nextConfig, aggregate.tableId, aggregate.fieldId);
  const candidateAttribute = parsedNativeAttribute(candidateRow);
  const nextAttribute = parsedNativeAttribute(nextRow);
  const expressionFormulaVO = candidateAttribute.config?.controlProps?.expressionFormulaVO;
  requireValue(expressionFormulaVO && typeof expressionFormulaVO === "object",
    "locked_draft.calculation_expression_required");
  nextAttribute.config = nextAttribute.config || {};
  nextAttribute.config.controlProps = nextAttribute.config.controlProps || {};
  nextAttribute.config.controlProps.expressionFormulaVO = structuredClone(expressionFormulaVO);
  nextRow.fdAttribute = JSON.stringify(nextAttribute);

  requireValue(
    text(candidateConfig.sign?.formula?.[signKey]),
    "locked_draft.calculation_sign_required"
  );
  nextConfig.sign = nextConfig.sign || {};
  nextConfig.sign.formula = nextConfig.sign.formula || {};
  nextConfig.sign.formula[signKey] = candidateConfig.sign.formula[signKey];

  const template = structuredClone(before.template);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(nextConfig);
  const changedPaths = [
    "/mechanisms/sys-xform/fdConfig/attribute/formAttr/formRule/compute",
    `/mechanisms/sys-xform/fdConfig/dataModel[detail:${aggregate.tableId}]/fdFields[${aggregate.fieldId}]/fdAttribute/config/controlProps/expressionFormulaVO`,
    `/mechanisms/sys-xform/fdConfig/sign/formula/${signKey}`
  ];
  requireValue(
    digest(protectedCalculationTemplate(before.template, {
      tableId: aggregate.tableId,
      fieldId: aggregate.fieldId
    })) === digest(protectedCalculationTemplate(template, {
      tableId: aggregate.tableId,
      fieldId: aggregate.fieldId
    })),
    "locked_draft.calculation_delta_outside_scope"
  );

  return {
    before,
    template,
    workflow: undefined,
    plan: {
      repairKind: "calculation",
      targetTemplateId: template.fdId,
      aggregateFieldId,
      detailTableId: aggregate.tableId,
      rowFormulaFieldId: aggregate.fieldId,
      changedPaths
    },
    verify(after) {
      const afterConfig = parsedXformConfig(after.template);
      const afterFormAttr = parsedFormAttr(afterConfig);
      const afterRowAttribute = parsedNativeAttribute(
        nativeDetailField(afterConfig, aggregate.tableId, aggregate.fieldId)
      );
      const computeOk = stableStringify(afterFormAttr.formRule?.compute || []) ===
        stableStringify(candidateFormAttr.formRule.compute);
      const expressionOk = stableStringify(
        afterRowAttribute.config?.controlProps?.expressionFormulaVO
      ) === stableStringify(expressionFormulaVO);
      const signOk = afterConfig.sign?.formula?.[signKey] === candidateConfig.sign.formula[signKey];
      const protectedOk = digest(protectedCalculationTemplate(before.template, {
        tableId: aggregate.tableId,
        fieldId: aggregate.fieldId
      })) === digest(protectedCalculationTemplate(after.template, {
        tableId: aggregate.tableId,
        fieldId: aggregate.fieldId
      }));
      return {
        ok: computeOk && expressionOk && signOk && protectedOk,
        checks: { computeOk, expressionOk, signOk, protectedOk }
      };
    }
  };
}

function observedAuthorization(template) {
  return Object.fromEntries(AUTHORIZATION_COLLECTIONS.map((collection) => [
    collection,
    ids(template?.[AUTHORIZATION_NATIVE_FIELDS[collection]])
  ]));
}

function findDslField(dsl, fieldId) {
  for (const field of dsl?.form?.fields || []) {
    if (field?.id === fieldId) return field;
    if (field?.type === "detailTable") {
      const column = (field.columns || []).find((candidate) => candidate?.id === fieldId);
      if (column) return column;
    }
  }
  return undefined;
}

function parsedXformConfig(template) {
  const value = template?.mechanisms?.["sys-xform"]?.fdConfig;
  requireValue(typeof value === "string", "locked_draft.xform_config_required");
  try {
    const parsed = JSON.parse(value);
    requireValue(parsed && typeof parsed === "object" && !Array.isArray(parsed),
      "locked_draft.xform_config_invalid");
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    throw coded("locked_draft.xform_config_invalid");
  }
}

function parsedFormAttr(config) {
  const value = config?.attribute?.formAttr;
  requireValue(typeof value === "string", "locked_draft.form_attr_required");
  try {
    const parsed = JSON.parse(value);
    requireValue(parsed && typeof parsed === "object" && !Array.isArray(parsed),
      "locked_draft.form_attr_invalid");
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    throw coded("locked_draft.form_attr_invalid");
  }
}

function nativeDetailField(config, tableId, fieldId) {
  const models = (config?.dataModel || []).filter((model) => (
    model?.fdType === "detail" && model?.dynamicProps?.detailFieldName === tableId
  ));
  requireValue(models.length === 1, "locked_draft.calculation_detail_model_mismatch");
  const fields = (models[0].fdFields || []).filter((field) => field?.fdName === fieldId);
  requireValue(fields.length === 1, "locked_draft.calculation_detail_field_mismatch");
  return fields[0];
}

function parsedNativeAttribute(field) {
  requireValue(typeof field?.fdAttribute === "string", "locked_draft.calculation_attribute_required");
  try {
    const parsed = JSON.parse(field.fdAttribute);
    requireValue(parsed && typeof parsed === "object" && !Array.isArray(parsed),
      "locked_draft.calculation_attribute_invalid");
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    throw coded("locked_draft.calculation_attribute_invalid");
  }
}

function protectedCalculationTemplate(template, { tableId, fieldId }) {
  const copy = normalizedProtected(structuredClone(template));
  const config = parsedXformConfig(copy);
  const formAttr = parsedFormAttr(config);
  if (formAttr.formRule) delete formAttr.formRule.compute;
  config.attribute.formAttr = formAttr;
  const row = nativeDetailField(config, tableId, fieldId);
  const attribute = parsedNativeAttribute(row);
  if (attribute.config?.controlProps) {
    delete attribute.config.controlProps.expressionFormulaVO;
  }
  row.fdAttribute = attribute;
  if (config.sign?.formula) delete config.sign.formula[`${fieldId}.expressionFormulaVO`];
  copy.mechanisms["sys-xform"].fdConfig = config;
  return copy;
}

function sourceAuthorizationMember(dsl, sourceId) {
  return AUTHORIZATION_COLLECTIONS
    .flatMap((collection) => dsl?.template?.authorization?.[collection] || [])
    .find((member) => member?.sourceId === sourceId || member?.id === sourceId);
}

function membersForIds(expectedIds, existing, elementById) {
  const existingById = new Map((existing || []).map((member) => [member?.fdId, member]));
  return expectedIds.map((id) => {
    if (existingById.has(id)) return structuredClone(existingById.get(id));
    const target = elementById.get(id);
    return { fdId: target.fdId, fdName: target.fdName, fdOrgType: Number(target.fdOrgType) };
  });
}

function authorizationChangedPaths(before, after) {
  const paths = [];
  for (const field of ["fdEditors", "fdAllReaders", "fdAllEditors"]) {
    if (stableStringify(ids(before.template[field])) !== stableStringify(ids(after.template[field]))) {
      paths.push(`/${field}`);
    }
  }
  if (stableStringify(ids(before.template.mechanisms.lbpmTemplate[0].fdEditors)) !==
    stableStringify(ids(after.template.mechanisms.lbpmTemplate[0].fdEditors))) {
    paths.push("/mechanisms/lbpmTemplate/0/fdEditors");
  }
  if (stableStringify(ids(before.workflow?.fdEditors)) !== stableStringify(ids(after.workflow?.fdEditors))) {
    paths.push("/workflowDetail/fdEditors");
  }
  return paths.sort();
}

function protectedAuthorizationBundle(bundle) {
  const copy = normalizedProtected(structuredClone(bundle));
  for (const field of ["fdEditors", "fdAllReaders", "fdAllEditors"]) delete copy.template[field];
  if (copy.template?.mechanisms?.lbpmTemplate?.[0]) {
    delete copy.template.mechanisms.lbpmTemplate[0].fdEditors;
  }
  if (copy.workflow) delete copy.workflow.fdEditors;
  return copy;
}

function normalizedProtected(value) {
  const copy = withoutMechanismTokens(value);
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    delete node.fdAlter;
    delete node.fdAlterTime;
    for (const child of Object.values(node)) visit(child);
  };
  visit(copy);
  const normalize = (owner, fields) => {
    if (!owner || typeof owner !== "object") return;
    for (const field of fields) {
      if (Array.isArray(owner[field])) owner[field] = ids(owner[field]);
    }
  };
  normalize(copy, Object.values(AUTHORIZATION_NATIVE_FIELDS));
  normalize(copy?.mechanisms?.lbpmTemplate?.[0], ["fdReaders", "fdEditors"]);
  normalize(copy.template, Object.values(AUTHORIZATION_NATIVE_FIELDS));
  normalize(copy.template?.mechanisms?.lbpmTemplate?.[0], ["fdReaders", "fdEditors"]);
  normalize(copy.workflow, ["fdReaders", "fdEditors"]);
  return copy;
}


function membersById(values) {
  const result = new Map();
  for (const member of values || []) {
    requireValue(text(member?.fdId) && !result.has(member.fdId), "locked_draft.authorization_member_invalid");
    result.set(member.fdId, member);
  }
  return result;
}

function ids(values) {
  return [...membersById(values).keys()].sort();
}

function sortedIds(values) {
  return [...new Set((values || []).filter(text))].sort();
}

function unionIds(...values) {
  return sortedIds(values.flat());
}

function coded(code) {
  return Object.assign(new Error(code), { code });
}

function requireValue(value, code) {
  if (!value) throw coded(code);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
