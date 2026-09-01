const STAGE = "resolveSubProcessTemplates";

export class SubProcessTemplateResolutionError extends Error {
  constructor(issues, options = {}) {
    super(
      `Could not resolve ${issues.length} subprocess template ${issues.length === 1 ? "reference" : "references"}.`,
      options.cause ? { cause: options.cause } : undefined
    );
    this.name = "SubProcessTemplateResolutionError";
    this.stage = STAGE;
    this.code = "workflow.subprocess_template_resolution_failed";
    this.issues = issues;
  }
}

export async function resolveSubProcessTemplates(dsl, { client, overrides } = {}) {
  const nextDsl = structuredClone(dsl);
  const references = collectSourceTemplateReferences(nextDsl);
  const overrideBySourceId = validateOverrides(references, overrides);
  if (references.length === 0) {
    return { dsl: nextDsl, resolvedCount: 0, sourceTemplateCount: 0, targetFdIds: [] };
  }

  const missing = references.filter((reference) => !overrideBySourceId.has(reference.sourceTemplateId));
  if (missing.length) {
    throw new SubProcessTemplateResolutionError(missing.map((reference) => ({
      reason: "subprocess_template_override_required",
      sourceTemplateId: reference.sourceTemplateId,
      paths: [reference.path]
    })));
  }
  const unverifiedParameters = references.filter((reference) =>
    Array.isArray(reference.subProcess.startParamConfig) &&
    reference.subProcess.startParamConfig.length > 0
  );
  if (unverifiedParameters.length) {
    throw new SubProcessTemplateResolutionError(unverifiedParameters.map((reference) => ({
      reason: "subprocess_start_parameter_contract_unverified",
      sourceTemplateId: reference.sourceTemplateId,
      targetFdId: overrideBySourceId.get(reference.sourceTemplateId),
      paths: [reference.path],
      targetParameters: reference.subProcess.startParamConfig.map((mapping) => ({
        value: normalizedText(mapping?.target?.value),
        type: normalizedText(mapping?.target?.type)
      }))
    })));
  }
  if (typeof client?.getTemplate !== "function") {
    throw new SubProcessTemplateResolutionError([{
      reason: "subprocess_template_read_unavailable",
      paths: references.map((reference) => reference.path)
    }]);
  }

  const targetById = new Map();
  for (const targetFdId of [...new Set(
    references.map((reference) => overrideBySourceId.get(reference.sourceTemplateId))
  )].sort()) {
    let target;
    try {
      target = await client.getTemplate(targetFdId);
    } catch (cause) {
      throw new SubProcessTemplateResolutionError([{
        reason: "subprocess_template_target_read_failed",
        targetFdId,
        paths: references
          .filter((reference) => overrideBySourceId.get(reference.sourceTemplateId) === targetFdId)
          .map((reference) => reference.path),
        message: cause instanceof Error ? cause.message : String(cause)
      }], { cause });
    }
    if (normalizedText(target?.fdId) !== targetFdId) {
      throw new SubProcessTemplateResolutionError([{
        reason: "subprocess_template_target_not_found",
        targetFdId,
        paths: references
          .filter((reference) => overrideBySourceId.get(reference.sourceTemplateId) === targetFdId)
          .map((reference) => reference.path)
      }]);
    }
    targetById.set(targetFdId, target);
  }

  const audits = [];
  for (const reference of references) {
    const targetFdId = overrideBySourceId.get(reference.sourceTemplateId);
    const target = targetById.get(targetFdId);
    reference.subProcess.templateId = targetFdId;
    audits.push({
      sourceTemplateId: reference.sourceTemplateId,
      target: {
        fdId: targetFdId,
        fdName: normalizedText(target?.fdName)
      },
      path: reference.path
    });
  }

  return {
    dsl: nextDsl,
    resolvedCount: references.length,
    sourceTemplateCount: new Set(references.map((reference) => reference.sourceTemplateId)).size,
    targetFdIds: [...targetById.keys()].sort(),
    overrides: audits
  };
}

function collectSourceTemplateReferences(dsl) {
  return (dsl?.workflow?.nodes || []).flatMap((node, nodeIndex) => {
    const subProcess = node?.type === "startSubProcess" ? node.subProcess : undefined;
    const sourceTemplateId = normalizedText(subProcess?.sourceTemplateId);
    if (!sourceTemplateId) return [];
    return [{
      sourceTemplateId,
      subProcess,
      path: `/workflow/nodes/${nodeIndex}/subProcess/sourceTemplateId`
    }];
  });
}

function validateOverrides(references, overrides) {
  if (overrides === undefined) overrides = [];
  if (!Array.isArray(overrides)) {
    throw new SubProcessTemplateResolutionError([{
      reason: "subprocess_template_override_configuration_invalid",
      paths: ["/execute/subProcessTemplateOverrides"]
    }]);
  }
  const sourceIds = new Set(references.map((reference) => reference.sourceTemplateId));
  const result = new Map();
  const issues = [];
  for (const [index, override] of overrides.entries()) {
    const sourceTemplateId = normalizedText(override?.sourceTemplateId);
    const targetFdId = normalizedText(override?.targetFdId);
    const path = `/execute/subProcessTemplateOverrides/${index}`;
    if (!sourceTemplateId || !targetFdId) {
      issues.push({ reason: "subprocess_template_override_invalid", paths: [path] });
      continue;
    }
    if (!sourceIds.has(sourceTemplateId)) {
      issues.push({
        reason: "subprocess_template_override_source_unknown",
        sourceTemplateId,
        targetFdId,
        paths: [path]
      });
      continue;
    }
    if (result.has(sourceTemplateId)) {
      issues.push({
        reason: "subprocess_template_override_source_duplicate",
        sourceTemplateId,
        paths: [path]
      });
      continue;
    }
    result.set(sourceTemplateId, targetFdId);
  }
  if (issues.length) throw new SubProcessTemplateResolutionError(issues);
  return result;
}

function normalizedText(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}
