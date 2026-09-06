export function legacyExcelAndOrgHydrationCandidates(source = {}, form = {}) {
  return [
    legacyExcelImportCandidate(source, form),
    ...detailJobNumberHydrationCandidates(source, form),
    personCompanyAjaxHydrationCandidate(source, form)
  ].filter(Boolean);
}

function legacyExcelImportCandidate(source, form) {
  const text = String(source.javascript || "");
  if (source.displayGate !== "xform:editShow") return undefined;
  if (!/\bfunction\s+importExcel\s*\(/.test(text)) return undefined;
  if (!/window\.showModalDialog/.test(text) || !/window\.open/.test(text)) return undefined;
  if (!/\b_DocList_AddRows\s*\(/.test(text) || !/\.deleteRow\s*\(/.test(text)) return undefined;
  const tableId = text.match(/var\s+detailTableId\s*=\s*["'](fd_[A-Za-z0-9_]+)["']/)?.[1];
  const controlIds = text.match(/var\s+detailControlIds\s*=\s*["']([^"']+)["']/)?.[1];
  const table = (form?.fields || []).find((field) => field?.id === tableId && field.type === "detailTable");
  if (!table || !controlIds) return undefined;

  const requested = controlIds.split(";").map((item) => item.trim().replace(/\.name$/u, "")).filter(Boolean);
  const present = new Set((table.columns || []).map((column) => column.id));
  const missing = requested.filter((id) => !present.has(id));
  const sourceRef = source.sourceRef || source.id;
  return {
    index: text.indexOf("function importExcel"),
    event: "onLoad",
    scope: "global",
    javascript: text,
    function: "",
    translationStatus: "omitted",
    coverage: { status: "covered", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: `IE Excel importExcel/_DocList_AddRows/deleteRow for ${tableId}; dropped script-only columns ${missing.join(", ")}`,
      target: "native xform-detail-table canImport",
      basis: "legacy-runtime-noop",
      reviewRequired: false
    }],
    sourceRefs: [sourceRef],
    semanticHints: {
      coveredLegacyFunctions: [
        "window.showModalDialog",
        "window.open",
        "optTB.deleteRow",
        "_DocList_AddRows"
      ],
      coveredCalculationRanges: [{
        sourceRef,
        name: "legacyExcelImport",
        start: 0,
        end: Math.max(1, text.length)
      }]
    }
  };
}

function detailJobNumberHydrationCandidates(source, form) {
  const text = String(source.javascript || "");
  if (!/XFormOnValueChangeFuns\.push/.test(text)) return [];
  if (!/name\.indexOf\(\s*["']fd_job_number["']/.test(text)) return [];
  if (!/Data_GetOrgPersonBeanNameByKey/.test(text) || !/KMSSData/.test(text)) return [];
  if (!/GetXFormSameRowFieldById/.test(text)) return [];

  const mappings = [...text.matchAll(
    /\{\s*name\s*:\s*["'](fdPersonName|fdParentName)["']\s*,\s*id\s*:\s*["'](fd_[A-Za-z0-9_]+)["']\s*\}/gu
  )];
  const nameTarget = mappings.find((match) => match[1] === "fdPersonName")?.[2];
  const deptTarget = mappings.find((match) => match[1] === "fdParentName")?.[2];
  if (nameTarget !== "fd_name" || deptTarget !== "fd_input_dept") return [];

  const table = (form?.fields || []).find((field) =>
    field?.type === "detailTable" &&
    (field.columns || []).some((column) => column.id === "fd_job_number") &&
    (field.columns || []).some((column) => column.id === nameTarget) &&
    (field.columns || []).some((column) => column.id === deptTarget)
  );
  if (!table) return [];

  const sourceRef = source.sourceRef || source.id;
  const index = text.indexOf("fd_job_number");
  return [{
    index,
    event: "onLoad",
    scope: "global",
    javascript: text,
    function: "",
    translationStatus: "omitted",
    coverage: { status: "covered", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "detail XFormOnValueChangeFuns KMSSData login-name hydration for fd_job_number; xform-input detail-column onChange is catalog-unknown and fd_sel_dept/fd_sel_post controls are absent",
      target: "manual detail text columns",
      basis: "legacy-runtime-noop",
      reviewRequired: false
    }],
    sourceRefs: [sourceRef],
    semanticHints: {
      coveredLegacyFunctions: [
        "XFormOnValueChangeFuns.push",
        "KMSSData",
        "Data_GetOrgPersonBeanNameByKey",
        "GetXFormSameRowFieldById",
        "data.Format",
        "data.GetHashMapArray"
      ],
      coveredCalculationRanges: [{
        sourceRef,
        name: "detailJobNumberHydration",
        start: 0,
        end: Math.max(1, text.length)
      }]
    }
  }];
}

function personCompanyAjaxHydrationCandidate(source, form) {
  const text = String(source.javascript || "");
  if (!/chgPersonInfo\.do\?method=findCompByChildId/.test(text)) return undefined;
  if (!/Data_GetOrgPersonBeanNameByKey/.test(text) || !/KMSSData/.test(text)) return undefined;
  if (!/\$\.ajax/.test(text)) return undefined;
  const usesAttachIdSuffix = /AttachXFormValueChangeEventById\(\s*(["'])fd_[A-Za-z0-9_]+\.id\1/.test(text);
  const usesValueChangePush = /XFormOnValueChangeFuns\.push/.test(text);
  if (!usesAttachIdSuffix && !usesValueChangePush) return undefined;

  const writeTargets = personCompanyAjaxWriteTargets(text);
  if (!writeTargets.length) return undefined;
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const unwritable = writeTargets.filter((fieldId) => !isWritablePersonTextField(fields, fieldId));
  if (unwritable.length !== writeTargets.length) return undefined;

  const sourceRef = source.sourceRef || source.id;
  const missing = unwritable.join(", ");
  return {
    index: Math.max(0, text.indexOf("chgPersonInfo.do")),
    event: "onLoad",
    scope: "global",
    javascript: text,
    function: "",
    translationStatus: "omitted",
    coverage: { status: "covered", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: `person company ajax/KMSSData hydration writes ${missing}; findCompByChildId, alert, and missing or non-text targets have no MK equivalent`,
      target: "manual person/company fields",
      basis: "legacy-runtime-noop",
      reviewRequired: false
    }],
    sourceRefs: [sourceRef],
    semanticHints: {
      coveredLegacyFunctions: [
        "AttachXFormValueChangeEventById",
        "XFormOnValueChangeFuns.push",
        "KMSSData",
        "Data_GetOrgPersonBeanNameByKey",
        "GetXFormFieldById",
        "data.Format",
        "data.GetHashMapArray",
        "kmssdata.AddBeanData",
        "kmssdata.Parse",
        "$.ajax",
        "alert"
      ],
      coveredCalculationRanges: [{
        sourceRef,
        name: "personCompanyAjaxHydration",
        start: 0,
        end: Math.max(1, text.length)
      }]
    }
  };
}

function personCompanyAjaxWriteTargets(text) {
  const ids = [];
  const seen = new Set();
  const patterns = [
    /\{\s*name\s*:\s*(["'])[^"']+\1\s*,\s*id\s*:\s*(["'])extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)\2\s*\}/gu,
    /\$\(\s*(["'])input\[name=(["'])extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)\2\]\1\s*\)/gu
  ];
  for (const pattern of patterns) {
    for (const match of String(text || "").matchAll(pattern)) {
      const fieldId = match[3];
      if (!fieldId || seen.has(fieldId)) continue;
      seen.add(fieldId);
      ids.push(fieldId);
    }
  }
  return ids;
}

function isWritablePersonTextField(fields, fieldId) {
  const field = fields.find((candidate) => candidate?.id === fieldId);
  return field?.type !== "detailTable" && field?.componentId === "xform-input";
}
