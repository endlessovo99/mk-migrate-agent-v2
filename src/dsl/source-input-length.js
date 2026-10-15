export const INPUT_LENGTH_POLICY = "qas-native-weighted-v1";
export const INPUT_LENGTH_POLICY_WARNING = "source.form.input_length_target_counting";

// Metadata storage length alone is not an explicit input validation limit.
export function sourceInputLength(source = {}) {
  return sourceRepresentationsLength([source]);
}

function sourceRepresentationsLength(sources) {
  const declared = sources.flatMap((source) =>
    lengthEntries(source.sourceProps?.designerValues, ["maxLength", "maxlength"], "designerValues"));
  if (!declared.length) return { status: "absent", evidence: [] };
  const evidence = [...new Map([
    ...declared,
    ...sources.flatMap((source) => lengthEntries(source.sourceProps?.metadataAttributes,
      ["maxLength", "maxlength", "length"], "metadataAttributes"))
  ].map((entry) => [JSON.stringify(entry), entry])).values()];
  const sourceIds = [...new Set(sources.map((source) => source.id))];
  if (sourceIds.length !== 1) return { status: "conflict", evidence, sourceIds };
  if (evidence.some((entry) => entry.limit === undefined)) return { status: "invalid", evidence };
  if (new Set(evidence.map((entry) => entry.limit)).size !== 1) return { status: "conflict", evidence };
  return { status: "valid", limit: declared[0].limit, evidence };
}

export function inputLengthRequirements(sourceForm = {}, targetForm = {}) {
  const sources = new Map();
  for (const field of [
    ...(sourceForm.controls || []),
    ...(sourceForm.dataFields || []),
    ...(sourceForm.detailTables || []).flatMap((table) => table.columns || [])
  ]) {
    if (!sources.has(field.sourceRef)) sources.set(field.sourceRef, []);
    sources.get(field.sourceRef).push(field);
  }
  const requirements = [];
  const collect = (field, path) => {
    if (field.componentId !== "xform-input") return;
    const representations = sources.get(field.sourceRef);
    if (!representations?.length) return;
    const source = representations[0];
    const fact = sourceRepresentationsLength(representations);
    if (fact.status !== "absent") requirements.push({ source, field, path, fact });
  };
  (targetForm.fields || []).forEach((field, index) => {
    const path = `/form/fields/${index}`;
    if (field.type === "detailTable") {
      (field.columns || []).forEach((column, columnIndex) => collect(column, `${path}/columns/${columnIndex}`));
    } else collect(field, path);
  });
  return requirements;
}

export function inputLengthPolicyWarning({ source, field, path, fact }) {
  return {
    code: INPUT_LENGTH_POLICY_WARNING,
    message: "Adopts the observed QAS native weighted length validation profile; source counting, HTML truncation equivalence, and other target runtimes are not verified.",
    path: `${path}/props/maxLength`,
    details: {
      sourceRef: source.sourceRef,
      sourceFieldId: source.id,
      fieldId: field.id,
      limit: fact.limit,
      policy: INPUT_LENGTH_POLICY,
      sourceCounting: "unverified",
      htmlTruncation: false,
      observedRuntimeSha256: "a3ee70fad7030bd66884aa39a2e28e59d3472671b0d633acd0fb05d4d48c91ba",
      evidence: fact.evidence
    }
  };
}

export function inputLengthSourceError({ source, path, fact }) {
  return {
    code: `source.form.input_length_${fact.status}`,
    message: "An explicit input length and its metadata evidence must be consistent positive safe integers before projection.",
    path: `${path}/props/maxLength`,
    details: {
      sourceRef: source.sourceRef, sourceFieldId: source.id, evidence: fact.evidence,
      ...(fact.sourceIds ? { sourceFieldIds: fact.sourceIds } : {})
    }
  };
}

function lengthEntries(object, keys, prefix) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return [];
  return keys.filter((key) => Object.hasOwn(object, key)).map((key) => ({
    path: `sourceProps.${prefix}.${key}`,
    value: object[key],
    limit: positiveInteger(object[key])
  }));
}

function positiveInteger(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return undefined;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
