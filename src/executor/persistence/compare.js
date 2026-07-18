import { INVARIANT_VERSION } from "./invariants.js";
import { diagnostic } from "./diagnostics.js";
import { expectedRuleFingerprint } from "./expected.js";
import { normalizeScalar, stableStringify } from "./normalize.js";

export function compareInvariants(expected, observedPartitions) {
  const diagnostics = [];
  const partitions = {
    envelope: comparePartition("envelope", expected.envelope, observedPartitions.envelope, compareEnvelope, diagnostics),
    form: comparePartition("form", expected.form, observedPartitions.form, compareForm, diagnostics),
    rules: comparePartition("rules", expected.rules, observedPartitions.rules, compareRules, diagnostics),
    scripts: comparePartition("scripts", expected.scripts, observedPartitions.scripts, compareScripts, diagnostics),
    workflow: compareWorkflowPartition(expected.workflow, observedPartitions.workflow, diagnostics)
  };

  const ok = diagnostics.every((item) => item.level !== "error");
  return {
    ok,
    status: ok ? "verified" : "readback_failed",
    invariantVersion: INVARIANT_VERSION,
    partitions,
    diagnostics
  };
}

function comparePartition(name, expected, observed, compareFn, diagnostics) {
  if (observed.status === "decode_failed") {
    diagnostics.push(...(observed.diagnostics || []));
    return "decode_failed";
  }
  const before = diagnostics.length;
  compareFn(expected, observed.value, diagnostics);
  const addedErrors = diagnostics.slice(before).some((item) => item.level === "error");
  return addedErrors ? "mismatch" : "verified";
}

function compareWorkflowPartition(expected, observed, diagnostics) {
  if (!expected?.expected) {
    return "not_expected";
  }
  if (observed.status === "decode_failed") {
    diagnostics.push(...(observed.diagnostics || []));
    return "decode_failed";
  }
  if (observed.status === "not_expected" || !observed.value) {
    diagnostics.push(mismatch("workflow", "readback.workflow.missing", "Readback workflow content is missing.", {
      invariantKey: "workflow.readable",
      path: "/readback/workflow"
    }));
    return "mismatch";
  }
  const before = diagnostics.length;
  compareWorkflow(expected, observed.value, diagnostics);
  return diagnostics.slice(before).some((item) => item.level === "error") ? "mismatch" : "verified";
}

function compareEnvelope(expected, actual, diagnostics) {
  assertEqual(diagnostics, "envelope", "readback.envelope.template_id", "templateId", expected.templateId, actual?.templateId, "/fdId");
  assertEqual(diagnostics, "envelope", "readback.envelope.template_name", "templateName", expected.templateName, actual?.templateName, "/fdName");
  assertEqual(diagnostics, "envelope", "readback.envelope.category_id", "categoryId", expected.categoryId, actual?.categoryId, "/fdCategory/fdId");
  assertEqual(diagnostics, "envelope", "readback.envelope.table_name", "tableName", expected.tableName, actual?.tableName, "/mechanisms/sys-xform/fdTableName");

  if (expected.lifecycle.fdStatus !== undefined && actual?.lifecycle?.fdStatus !== expected.lifecycle.fdStatus) {
    diagnostics.push(mismatch("envelope", "readback.envelope.fd_status", "Readback template lifecycle fdStatus mismatch.", {
      invariantKey: "envelope.lifecycle.fdStatus",
      path: "/fdStatus",
      expected: expected.lifecycle.fdStatus,
      actual: actual?.lifecycle?.fdStatus
    }));
  }
  if (expected.lifecycle.xformStatus && actual?.lifecycle?.xformStatus !== expected.lifecycle.xformStatus) {
    diagnostics.push(mismatch("envelope", "readback.envelope.xform_status", "Readback xform draft status mismatch.", {
      invariantKey: "envelope.lifecycle.xformStatus",
      path: "/mechanisms/sys-xform/fdStatus",
      expected: expected.lifecycle.xformStatus,
      actual: actual?.lifecycle?.xformStatus
    }));
  }
  if (expected.lifecycle.lbpmStatus && actual?.lifecycle?.lbpmStatus !== expected.lifecycle.lbpmStatus) {
    diagnostics.push(mismatch("envelope", "readback.envelope.lbpm_status", "Readback workflow draft status mismatch.", {
      invariantKey: "envelope.lifecycle.lbpmStatus",
      path: "/mechanisms/lbpmTemplate/0/fdStatus",
      expected: expected.lifecycle.lbpmStatus,
      actual: actual?.lifecycle?.lbpmStatus
    }));
  }
  if (
    expected.lifecycle.lbpmIsDraft !== undefined &&
    actual?.lifecycle?.lbpmIsDraft !== expected.lifecycle.lbpmIsDraft
  ) {
    diagnostics.push(mismatch("envelope", "readback.envelope.lbpm_is_draft", "Readback workflow isDraft marker mismatch.", {
      invariantKey: "envelope.lifecycle.lbpmIsDraft",
      path: "/mechanisms/lbpmTemplate/0/isDraft",
      expected: expected.lifecycle.lbpmIsDraft,
      actual: actual?.lifecycle?.lbpmIsDraft
    }));
  }
  if (expected.bindings.formFdId && actual?.bindings?.formFdId && actual.bindings.formFdId !== expected.bindings.formFdId) {
    diagnostics.push(mismatch("envelope", "readback.envelope.form_binding", "Readback form binding fdId mismatch.", {
      invariantKey: "envelope.bindings.formFdId",
      path: "/mechanisms/sys-xform/fdId",
      expected: expected.bindings.formFdId,
      actual: actual.bindings.formFdId
    }));
  }
}

function compareForm(expected, actual, diagnostics) {
  if (stableStringify(expected.subjectRule) !== stableStringify(actual?.subjectRule)) {
    diagnostics.push(mismatch("form", "readback.form.subject_rule_mismatch", "Readback form subjectRule must remain empty.", {
      invariantKey: "form.subjectRule",
      path: "/mechanisms/sys-xform/fdConfig/attribute/formAttr/subjectRule",
      expected: expected.subjectRule,
      actual: actual?.subjectRule
    }));
  }

  const actualFields = new Map((actual?.fields || []).map((field) => [field.id, field]));
  const expectedIds = new Set((expected.fields || []).map((field) => field.id));

  for (const field of expected.fields || []) {
    const actualField = actualFields.get(field.id);
    if (!actualField) {
      diagnostics.push(mismatch("form", "readback.form.field_missing", "Readback form is missing a DSL field.", {
        invariantKey: `form.fields.${field.id}`,
        path: "/readback/form/fields",
        details: { fieldId: field.id }
      }));
      continue;
    }
    if (actualField.attributeCorrupt) {
      diagnostics.push(mismatch("form", "readback.decode.fdAttribute.invalid_json", "Readback field native attribute JSON is malformed.", {
        invariantKey: `form.fields.${field.id}.nativeAttribute`,
        path: `/mechanisms/sys-xform/fdConfig/dataModel/${field.id}/fdAttribute`,
        details: { fieldId: field.id }
      }));
      diagnostics.push(mismatch("form", "readback.form.required_mismatch", "Readback field attribute is corrupt and cannot prove required persistence.", {
        invariantKey: `form.fields.${field.id}.props.required`,
        path: `/readback/form/fields/${field.id}`,
        details: { fieldId: field.id }
      }));
      continue;
    }
    assertEqual(diagnostics, "form", "readback.form.field_title", `form.fields.${field.id}.title`, field.title, actualField.title, `/readback/form/fields/${field.id}/title`);
    assertEqual(diagnostics, "form", "readback.form.component_mismatch", `form.fields.${field.id}.component`, field.component, actualField.component, `/readback/form/fields/${field.id}/component`);
    if (Boolean(field.dataOnly) !== Boolean(actualField.dataOnly)) {
      diagnostics.push(mismatch("form", "readback.form.data_only_flag_mismatch", "Readback data-only visibility mismatch.", {
        invariantKey: `form.fields.${field.id}.dataOnly`,
        path: `/readback/form/fields/${field.id}`,
        expected: field.dataOnly === true,
        actual: actualField.dataOnly === true
      }));
    }
    compareProps(diagnostics, "form", `form.fields.${field.id}.props`, field.props, actualField.props, `/readback/form/fields/${field.id}/props`);

    if (field.type === "detailTable") {
      const expectedColumnOrder = (field.columns || []).map((column) => column.id);
      const actualColumnOrder = (actualField.columns || []).map((column) => column.id);
      if (stableStringify(expectedColumnOrder) !== stableStringify(actualColumnOrder)) {
        diagnostics.push(mismatch("form", "readback.form.detail_column_order_mismatch", "Readback detail column order does not match the DSL.", {
          invariantKey: `form.fields.${field.id}.columnOrder`,
          path: `/readback/form/fields/${field.id}/columns`,
          expected: expectedColumnOrder,
          actual: actualColumnOrder,
          details: { fieldId: field.id }
        }));
      }
      const actualColumns = new Map((actualField.columns || []).map((column) => [column.id, column]));
      const expectedColumnIds = new Set((field.columns || []).map((column) => column.id));
      for (const column of field.columns || []) {
        const actualColumn = actualColumns.get(column.id);
        if (!actualColumn) {
          diagnostics.push(mismatch("form", "readback.form.detail_column_missing", "Readback detail table is missing a column.", {
            invariantKey: `form.fields.${field.id}.columns.${column.id}`,
            path: `/readback/form/fields/${field.id}/columns`,
            details: { fieldId: field.id, columnId: column.id }
          }));
          continue;
        }
        assertEqual(diagnostics, "form", "readback.form.detail_column_title", `form.fields.${field.id}.columns.${column.id}.title`, column.title, actualColumn.title);
        assertEqual(diagnostics, "form", "readback.form.detail_column_component", `form.fields.${field.id}.columns.${column.id}.component`, column.component, actualColumn.component);
        compareProps(diagnostics, "form", `form.fields.${field.id}.columns.${column.id}.props`, column.props, actualColumn.props);
      }
      for (const column of actualField.columns || []) {
        if (!expectedColumnIds.has(column.id)) {
          diagnostics.push(mismatch("form", "readback.form.unexpected_detail_column", "Readback detail table has an unexpected column.", {
            invariantKey: `form.fields.${field.id}.columns.${column.id}`,
            path: `/readback/form/fields/${field.id}/columns`,
            details: { fieldId: field.id, columnId: column.id }
          }));
        }
      }
    }
  }

  for (const field of actual?.fields || []) {
    if (!expectedIds.has(field.id)) {
      diagnostics.push(mismatch("form", "readback.form.unexpected_field", "Readback form has an unexpected field.", {
        invariantKey: `form.fields.${field.id}`,
        path: "/readback/form/fields",
        details: { fieldId: field.id }
      }));
    }
  }

  compareDetailPersistence(expected.persistence, actual?.persistence, diagnostics);
  compareLayout(expected.layoutRows || [], actual?.layoutRows || [], diagnostics, expected.fields || []);
}

function compareDetailPersistence(expected = {}, actual = {}, diagnostics) {
  const expectedDetails = new Map(
    (expected.detailModels || []).map((model) => [model.fieldId, model])
  );
  const actualDetails = actual.detailModels || [];
  const actualDetailsByFieldId = new Map();

  for (const model of actualDetails) {
    const models = actualDetailsByFieldId.get(model.fieldId) || [];
    models.push(model);
    actualDetailsByFieldId.set(model.fieldId, models);
  }

  for (const [fieldId, models] of actualDetailsByFieldId) {
    if (!expectedDetails.has(fieldId) || models.length <= 1) continue;
    diagnostics.push(mismatch("form", "readback.form.detail_model_duplicate", "Readback contains more than one data model for the same DSL detail field.", {
      invariantKey: `form.persistence.detailModels.${fieldId}.count`,
      path: "/mechanisms/sys-xform/fdConfig/dataModel",
      expected: { count: 1 },
      actual: {
        count: models.length,
        modelIndexes: models.map((model) => model.modelIndex)
      }
    }));
  }

  if (expected.distinctModelTableNames === true) {
    compareDistinctModelTables(actual.models || [], diagnostics);
  }

  for (const model of actualDetails) {
    const expectedModel = expectedDetails.get(model.fieldId);
    const modelPath = `/mechanisms/sys-xform/fdConfig/dataModel/${model.modelIndex}`;
    if (!expectedModel) {
      diagnostics.push(mismatch("form", "readback.form.detail_model_binding_mismatch", "Readback detail model is not bound to an expected DSL detail field.", {
        invariantKey: `form.persistence.detailModels.${model.fieldId || model.modelIndex}`,
        path: `${modelPath}/fdAttribute`,
        expected: { detailFieldIds: [...expectedDetails.keys()] },
        actual: { detailFieldId: model.fieldId }
      }));
      continue;
    }

    if (model.tableName !== expectedModel.tableName) {
      diagnostics.push(mismatch("form", "readback.form.detail_model_table_name_mismatch", "Readback detail model does not use the physical table derived from its main model and DSL field.", {
        invariantKey: `form.persistence.detailModels.${expectedModel.fieldId}.tableName`,
        path: `${modelPath}/fdTableName`,
        expected: expectedModel.tableName,
        actual: model.tableName
      }));
    }

    if (expectedModel.requireModelControlBinding === true) {
      const binding = model.controlBinding || {};
      const bindingMatches = Boolean(
        model.modelId &&
        model.modelName &&
        model.tableName &&
        binding.readable === true &&
        binding.detailFieldId === expectedModel.fieldId &&
        binding.tableType === expectedModel.tableType &&
        binding.tableName === model.tableName &&
        (!model.tableNameAlias || model.tableNameAlias === model.tableName)
      );
      if (!bindingMatches) {
        diagnostics.push(mismatch("form", "readback.form.detail_model_binding_mismatch", "Readback detail model control binding does not identify its DSL field and physical table.", {
          invariantKey: `form.persistence.detailModels.${expectedModel.fieldId}.binding`,
          path: `${modelPath}/fdAttribute`,
          expected: {
            readable: true,
            detailFieldId: expectedModel.fieldId,
            tableType: expectedModel.tableType,
            tableName: model.tableName,
            tableNameAlias: model.tableName
          },
          actual: {
            ...binding,
            modelId: model.modelId,
            modelName: model.modelName,
            tableName: model.tableName,
            tableNameAlias: model.tableNameAlias
          }
        }));
      }
    }

    const nativeTitle = model.controlBinding?.title;
    if (nativeTitle !== expectedModel.title) {
      diagnostics.push(mismatch("form", "readback.form.detail_control_title_mismatch", "Readback detail control title does not match its DSL title.", {
        invariantKey: `form.persistence.detailModels.${expectedModel.fieldId}.controlTitle`,
        path: `${modelPath}/fdAttribute/config/controlProps/title`,
        expected: expectedModel.title,
        actual: nativeTitle
      }));
    }

    const nativeLabel = model.controlBinding?.label;
    if (nativeLabel !== expectedModel.title) {
      diagnostics.push(mismatch("form", "readback.form.detail_control_label_mismatch", "Readback detail container label does not match its DSL title.", {
        invariantKey: `form.persistence.detailModels.${expectedModel.fieldId}.controlLabel`,
        path: `${modelPath}/fdAttribute/config/label`,
        expected: expectedModel.title,
        actual: nativeLabel
      }));
    }

    const actualColumns = new Map((model.columns || []).map((column) => [column.id, column]));
    for (const columnId of expectedModel.columnIds || []) {
      const column = actualColumns.get(columnId);
      if (!column) continue;
      const fieldPath = `${modelPath}/fdFields/${column.fieldIndex}`;

      if (column.mechanismType !== expectedModel.fieldMechanismType) {
        diagnostics.push(mismatch("form", "readback.form.detail_field_mechanism_type_mismatch", "Readback detail business field must use the SYS-XFORM mechanism.", {
          invariantKey: `form.persistence.detailModels.${expectedModel.fieldId}.columns.${columnId}.mechanismType`,
          path: `${fieldPath}/fdMechanismType`,
          expected: expectedModel.fieldMechanismType,
          actual: column.mechanismType
        }));
      }

      if (column.columnName !== expectedModel.fieldColumnName) {
        diagnostics.push(mismatch("form", "readback.form.detail_field_column_mismatch", "Readback detail business field must use the platform-managed physical column mapping.", {
          invariantKey: `form.persistence.detailModels.${expectedModel.fieldId}.columns.${columnId}.columnName`,
          path: `${fieldPath}/fdColumn`,
          expected: expectedModel.fieldColumnName,
          actual: column.columnName
        }));
      }

      if (expectedModel.requireFieldModelBinding === true) {
        const modelBinding = column.dataModel || {};
        if (!model.modelId || !model.modelName ||
          modelBinding.id !== model.modelId || modelBinding.name !== model.modelName) {
          diagnostics.push(mismatch("form", "readback.form.detail_field_model_binding_mismatch", "Readback detail business field is not bound to its containing data model.", {
            invariantKey: `form.persistence.detailModels.${expectedModel.fieldId}.columns.${columnId}.dataModel`,
            path: `${fieldPath}/fdDataModel`,
            expected: { id: model.modelId, name: model.modelName },
            actual: modelBinding
          }));
        }
      }

      if (expectedModel.requireFieldTableBinding === true) {
        const controlBinding = column.controlBinding || {};
        const bindingMatches = Boolean(
          controlBinding.readable === true &&
          controlBinding.fieldName === columnId &&
          controlBinding.tableType === expectedModel.tableType &&
          controlBinding.tableName === model.tableName
        );
        if (!bindingMatches) {
          diagnostics.push(mismatch("form", "readback.form.detail_field_table_binding_mismatch", "Readback detail business field control is not bound to its containing physical table.", {
            invariantKey: `form.persistence.detailModels.${expectedModel.fieldId}.columns.${columnId}.tableBinding`,
            path: `${fieldPath}/fdAttribute`,
            expected: {
              readable: true,
              fieldName: columnId,
              tableType: expectedModel.tableType,
              tableName: model.tableName
            },
            actual: controlBinding
          }));
        }
      }
    }
  }
}

function compareDistinctModelTables(models, diagnostics) {
  const firstModelByTable = new Map();
  for (const model of models) {
    const tableName = normalizeScalar(model.tableName);
    if (!tableName) continue;
    const key = String(tableName).toLowerCase();
    const previous = firstModelByTable.get(key);
    if (!previous) {
      firstModelByTable.set(key, model);
      continue;
    }
    if (previous.modelType !== "detail" && model.modelType !== "detail") continue;
    diagnostics.push(mismatch("form", "readback.form.detail_table_cross_model_conflict", "Readback reuses one physical detail table across multiple data models.", {
      invariantKey: "form.persistence.distinctModelTableNames",
      path: `/mechanisms/sys-xform/fdConfig/dataModel/${model.modelIndex}/fdTableName`,
      expected: { distinct: true },
      actual: {
        tableName,
        models: [
          { index: previous.modelIndex, id: previous.modelId, type: previous.modelType },
          { index: model.modelIndex, id: model.modelId, type: model.modelType }
        ]
      }
    }));
  }
}

function compareLayout(expectedRows, actualRows, diagnostics, fields) {
  if (expectedRows.length !== actualRows.length) {
    diagnostics.push(mismatch("form", "readback.form.layout_row_count_mismatch", "Readback form layout row count does not match DSL.", {
      invariantKey: "form.layout.rowCount",
      path: "/readback/form/layoutRows",
      expected: expectedRows.length,
      actual: actualRows.length
    }));
  }

  const dataOnlyIds = new Set(fields.filter((field) => field.dataOnly === true).map((field) => field.id));
  const actualLayoutFieldIds = new Set(
    actualRows.flatMap((row) => row.cells.flatMap((cell) => cell.fieldIds || []))
  );
  for (const fieldId of dataOnlyIds) {
    if (actualLayoutFieldIds.has(fieldId)) {
      diagnostics.push(mismatch("form", "readback.form.data_only_field_rendered", "Readback layout unexpectedly renders a data-only field.", {
        invariantKey: `form.layout.dataOnly.${fieldId}`,
        path: "/readback/form/layoutRows",
        details: { fieldId }
      }));
    }
  }

  expectedRows.forEach((expectedRow, rowIndex) => {
    const actualRow = actualRows[rowIndex];
    if (!actualRow) return;
    if (expectedRow.rows !== actualRow.rows || expectedRow.columns !== actualRow.columns) {
      diagnostics.push(mismatch("form", "readback.form.layout_grid_size_mismatch", "Readback form layout grid size does not match DSL.", {
        invariantKey: `form.layout.rows.${rowIndex}.grid`,
        path: `/readback/form/layoutRows/${rowIndex}`,
        expected: { rows: expectedRow.rows, columns: expectedRow.columns },
        actual: { rows: actualRow.rows, columns: actualRow.columns }
      }));
    }
    if ((expectedRow.cells || []).length !== (actualRow.cells || []).length) {
      diagnostics.push(mismatch("form", "readback.form.layout_cells_mismatch", "Readback form layout cell count does not match DSL.", {
        invariantKey: `form.layout.rows.${rowIndex}.cells`,
        path: `/readback/form/layoutRows/${rowIndex}/cells`,
        expected: (expectedRow.cells || []).length,
        actual: (actualRow.cells || []).length
      }));
      return;
    }
    (expectedRow.cells || []).forEach((expectedCell, cellIndex) => {
      const actualCell = actualRow.cells[cellIndex];
      if (!actualCell) return;
      if (stableStringify(expectedCell.fieldIds || []) !== stableStringify(actualCell.fieldIds || [])) {
        diagnostics.push(mismatch("form", "readback.form.layout_cell_fields_mismatch", "Readback form layout cell fields do not match DSL.", {
          invariantKey: `form.layout.rows.${rowIndex}.cells.${cellIndex}.fieldIds`,
          path: `/readback/form/layoutRows/${rowIndex}/cells/${cellIndex}/fieldIds`,
          expected: expectedCell.fieldIds,
          actual: actualCell.fieldIds
        }));
      }
      if (
        expectedCell.row !== actualCell.row ||
        expectedCell.column !== actualCell.column ||
        expectedCell.colspan !== actualCell.colspan
      ) {
        diagnostics.push(mismatch("form", "readback.form.layout_cell_position_mismatch", "Readback form layout cell position does not match DSL.", {
          invariantKey: `form.layout.rows.${rowIndex}.cells.${cellIndex}.position`,
          path: `/readback/form/layoutRows/${rowIndex}/cells/${cellIndex}`,
          expected: { row: expectedCell.row, column: expectedCell.column, colspan: expectedCell.colspan },
          actual: { row: actualCell.row, column: actualCell.column, colspan: actualCell.colspan }
        }));
      }
    });

    for (const actualCell of actualRow.cells || []) {
      for (const fieldId of actualCell.fieldIds || []) {
        if (!fields.some((field) => field.id === fieldId) && !dataOnlyIds.has(fieldId)) {
          // unexpected reference already covered by unexpected field; keep closed-world on refs
        }
      }
    }
  });
}

function compareProps(diagnostics, partition, invariantKey, expected = {}, actual = {}, path) {
  for (const [key, value] of Object.entries(expected || {})) {
    if (key === "componentId") continue;
    if (stableStringify(value) !== stableStringify(actual?.[key])) {
      const code = key === "required"
        ? "readback.form.required_mismatch"
        : `readback.form.prop_${key}_mismatch`;
      diagnostics.push(mismatch(partition, code, `Readback executable prop ${key} mismatch.`, {
        invariantKey: `${invariantKey}.${key}`,
        path,
        expected: value,
        actual: actual?.[key],
        details: invariantKey.includes("fields.")
          ? {
              fieldId: invariantKey.split(".")[2],
              ...(invariantKey.includes(".columns.") ? { columnId: invariantKey.split(".")[4] } : {})
            }
          : undefined
      }));
    }
  }
}

function compareRules(expected, actual, diagnostics) {
  const observed = [...(actual?.rules || [])];
  for (const rule of expected.rules || []) {
    const fingerprint = expectedRuleFingerprint(rule);
    const index = observed.findIndex((candidate) => expectedRuleFingerprint({
      kind: candidate.kind,
      logic: candidate.logic,
      conditions: candidate.conditions,
      effects: candidate.effects
    }) === fingerprint);
    if (index === -1) {
      diagnostics.push(mismatch("rules", "readback.form_rules.semantic_missing", "Readback is missing an expected form-rule semantic.", {
        invariantKey: `rules.${rule.kind}.${rule.ruleId}.${rule.branch}`,
        path: "/readback/form/formRules",
        details: {
          kind: rule.kind,
          ruleId: rule.ruleId,
          branch: rule.branch
        }
      }));
      continue;
    }
    observed.splice(index, 1);
  }
  // Open-world: leftover observed rules are allowed (manual additions).
}

function compareScripts(expected, actual, diagnostics) {
  const expectedActions = (expected.actions || []).filter((action) => !action.omitted);
  const omittedIds = new Set((expected.actions || []).filter((action) => action.omitted).map((action) => action.id));
  const actualActions = [...(actual?.actions || [])];
  compareScriptDispatchers(expected.dispatchers, actual?.dispatchers, diagnostics);

  for (const actionId of omittedIds) {
    if (actualActions.some((action) => action.id === actionId)) {
      diagnostics.push(mismatch("scripts", "readback.scripts.omitted_action_present", "Omitted DSL script action was unexpectedly persisted.", {
        invariantKey: `scripts.actions.${actionId}`,
        path: "/readback/scripts/actions",
        details: { actionId }
      }));
    }
  }

  for (const expectedAction of expectedActions) {
    const matchIndex = actualActions.findIndex((candidate) => scriptMatches(expectedAction, candidate));
    if (matchIndex === -1) {
      diagnostics.push(mismatch("scripts", "readback.scripts.action_missing", "Readback is missing an executable DSL script action.", {
        invariantKey: `scripts.actions.${expectedAction.id}`,
        path: "/readback/scripts/actions",
        details: {
          actionId: expectedAction.id,
          event: expectedAction.event,
          scope: expectedAction.scope
        }
      }));
      continue;
    }
    const actualAction = actualActions[matchIndex];
    actualActions.splice(matchIndex, 1);

    if (expectedAction.event !== actualAction.event || expectedAction.scope !== actualAction.scope) {
      diagnostics.push(mismatch("scripts", "readback.scripts.binding_mismatch", "Readback script action binding mismatch.", {
        invariantKey: `scripts.actions.${expectedAction.id}.binding`,
        path: "/readback/scripts/actions",
        expected: { event: expectedAction.event, scope: expectedAction.scope },
        actual: { event: actualAction.event, scope: actualAction.scope }
      }));
    }
    if (expectedAction.bodyDigest && actualAction.bodyDigest && expectedAction.bodyDigest !== actualAction.bodyDigest) {
      diagnostics.push(mismatch("scripts", "readback.scripts.body_digest_mismatch", "Readback script body digest mismatch.", {
        invariantKey: `scripts.actions.${expectedAction.id}.bodyDigest`,
        path: "/readback/scripts/actions",
        expected: expectedAction.bodyDigest,
        actual: actualAction.bodyDigest
      }));
    }
    if (expectedAction.runWhen) {
      const expectedStatuses = expectedAction.runWhen.viewStatusIn || [];
      const actualStatuses = actualAction.runWhen?.viewStatusIn || [];
      if (stableStringify(expectedStatuses) !== stableStringify(actualStatuses) || actualAction.hasCanonicalGuard !== true) {
        diagnostics.push(mismatch("scripts", "readback.scripts.run_when_mismatch", "Readback script action did not preserve its immutable view-status gate and canonical guard.", {
          invariantKey: `scripts.actions.${expectedAction.id}.runWhen`,
          path: "/readback/scripts/actions",
          expected: expectedAction.runWhen,
          actual: {
            runWhen: actualAction.runWhen,
            hasCanonicalGuard: actualAction.hasCanonicalGuard
          }
        }));
      }
    }
  }

  for (const leftover of actualActions) {
    if (omittedIds.has(leftover.id)) continue;
    diagnostics.push(mismatch("scripts", "readback.scripts.unexpected_action", "Readback has an unexpected script action.", {
      invariantKey: `scripts.actions.${leftover.id || leftover.event}`,
      path: "/readback/scripts/actions",
      details: {
        actionId: leftover.id,
        event: leftover.event,
        scope: leftover.scope
      }
    }));
  }
}

function compareScriptDispatchers(expectedDispatchers = [], actualDispatchers = [], diagnostics) {
  for (const expected of expectedDispatchers || []) {
    const actual = (actualDispatchers || []).find((candidate) => candidate.event === expected.event);
    if (!actual || stableStringify(actual) !== stableStringify(expected)) {
      diagnostics.push(mismatch(
        "scripts",
        "readback.scripts.dispatcher_mismatch",
        "Readback singleton global dispatcher did not preserve child definitions, invocation order, or execution strategy.",
        {
          invariantKey: `scripts.dispatchers.${expected.event}`,
          path: `/readback/scripts/dispatchers/${expected.event}`,
          expected,
          actual
        }
      ));
    }
  }
}

function scriptMatches(expected, actual) {
  if (expected.id && actual.id && expected.id === actual.id) return true;
  if (expected.bodyDigest && actual.bodyDigest && expected.bodyDigest === actual.bodyDigest) {
    return expected.event === actual.event && expected.scope === actual.scope;
  }
  return expected.event === actual.event &&
    expected.scope === actual.scope &&
    (!expected.controlId || !actual.controlKey || String(actual.controlKey).includes(expected.controlId));
}

function compareWorkflow(expected, actual, diagnostics) {
  if (!actual?.readable) {
    diagnostics.push(mismatch("workflow", "readback.workflow.unreadable", "Readback workflow content is not readable.", {
      invariantKey: "workflow.readable",
      path: "/readback/workflow"
    }));
    return;
  }

  const actualNodes = new Map((actual.nodes || []).map((node) => [node.id, node]));
  const expectedNodeIds = new Set((expected.nodes || []).map((node) => node.id));
  for (const node of expected.nodes || []) {
    const actualNode = actualNodes.get(node.id);
    if (!actualNode) {
      diagnostics.push(mismatch("workflow", "readback.workflow.node_missing", "Readback workflow is missing a DSL node.", {
        invariantKey: `workflow.nodes.${node.id}`,
        path: "/readback/workflow/nodes",
        details: { nodeId: node.id }
      }));
      continue;
    }
    assertEqual(diagnostics, "workflow", "readback.workflow.node_type_mismatch", `workflow.nodes.${node.id}.type`, node.type, actualNode.type);
    assertEqual(diagnostics, "workflow", "readback.workflow.node_element_mismatch", `workflow.nodes.${node.id}.element`, node.element, actualNode.element);
    if (node.name && actualNode.name && node.name !== actualNode.name) {
      diagnostics.push(mismatch("workflow", "readback.workflow.node_name_mismatch", "Readback workflow node name mismatch.", {
        invariantKey: `workflow.nodes.${node.id}.name`,
        path: `/readback/workflow/nodes/${node.id}/name`,
        expected: node.name,
        actual: actualNode.name
      }));
    }
    if (node.help !== undefined && node.help !== actualNode.help) {
      diagnostics.push(mismatch("workflow", "readback.workflow.node_help_mismatch", "Readback workflow node help mismatch.", {
        invariantKey: `workflow.nodes.${node.id}.help`,
        path: `/readback/workflow/nodes/${node.id}/help`,
        expected: node.help,
        actual: actualNode.help,
        details: { nodeId: node.id }
      }));
    }
    if (node.ignoreOnSameIdentity !== undefined &&
      node.ignoreOnSameIdentity !== actualNode.ignoreOnSameIdentity) {
      diagnostics.push(mismatch("workflow", "readback.workflow.same_identity_policy_mismatch", "Readback workflow same-identity policy mismatch.", {
        invariantKey: `workflow.nodes.${node.id}.ignoreOnSameIdentity`,
        path: `/readback/workflow/nodes/${node.id}/ignoreOnSameIdentity`,
        expected: node.ignoreOnSameIdentity,
        actual: actualNode.ignoreOnSameIdentity
      }));
    }
    if ((node.mustModifyHandlerNodeIds || []).length > 0 &&
      stableStringify(node.mustModifyHandlerNodeIds) !== stableStringify(actualNode.mustModifyHandlerNodeIds || [])) {
      diagnostics.push(mismatch("workflow", "readback.workflow.participant_mismatch", "Readback workflow draft-selection linkage mismatch.", {
        invariantKey: `workflow.nodes.${node.id}.mustModifyHandlerNodeIds`,
        path: `/readback/workflow/nodes/${node.id}/mustModifyHandlerNodeIds`,
        expected: node.mustModifyHandlerNodeIds,
        actual: actualNode.mustModifyHandlerNodeIds
      }));
    }
    if ((node.canModifyHandlerNodeIds || []).length > 0 &&
      stableStringify(node.canModifyHandlerNodeIds) !== stableStringify(actualNode.canModifyHandlerNodeIds || [])) {
      diagnostics.push(mismatch("workflow", "readback.workflow.participant_mismatch", "Readback workflow optional draft-selection linkage mismatch.", {
        invariantKey: `workflow.nodes.${node.id}.canModifyHandlerNodeIds`,
        path: `/readback/workflow/nodes/${node.id}/canModifyHandlerNodeIds`,
        expected: node.canModifyHandlerNodeIds,
        actual: actualNode.canModifyHandlerNodeIds
      }));
    }
    if (node.participants) {
      if (!participantsEquivalent(node.participants, actualNode.participants || {})) {
        diagnostics.push(mismatch("workflow", "readback.workflow.participant_mismatch", "Readback workflow participant mismatch.", {
          invariantKey: `workflow.nodes.${node.id}.participants`,
          path: `/readback/workflow/nodes/${node.id}/participants`,
          expected: node.participants,
          actual: actualNode.participants
        }));
      }
    }
    if (node.alternativeParticipants &&
      stableStringify(node.alternativeParticipants) !== stableStringify(actualNode.alternativeParticipants || {})) {
      diagnostics.push(mismatch("workflow", "readback.workflow.participant_mismatch", "Readback workflow alternative-handler candidate range mismatch.", {
        invariantKey: `workflow.nodes.${node.id}.alternativeParticipants`,
        path: `/readback/workflow/nodes/${node.id}/alternativeParticipants`,
        expected: node.alternativeParticipants,
        actual: actualNode.alternativeParticipants
      }));
    }
    if (node.sendConfig &&
      stableStringify(node.sendConfig) !== stableStringify(actualNode.sendConfig || {})) {
      diagnostics.push(mismatch("workflow", "readback.workflow.send_config_mismatch", "Readback workflow send-node configuration mismatch.", {
        invariantKey: `workflow.nodes.${node.id}.sendConfig`,
        path: `/readback/workflow/nodes/${node.id}/sendConfig`,
        expected: node.sendConfig,
        actual: actualNode.sendConfig
      }));
    }
    if (node.manualBranch &&
      stableStringify(node.manualBranch) !== stableStringify(actualNode.manualBranch || {})) {
      diagnostics.push(mismatch("workflow", "readback.workflow.manual_branch_mismatch", "Readback manual-branch configuration mismatch.", {
        invariantKey: `workflow.nodes.${node.id}.manualBranch`,
        path: `/readback/workflow/nodes/${node.id}/manualBranch`,
        expected: node.manualBranch,
        actual: actualNode.manualBranch,
        details: { nodeId: node.id }
      }));
    }
    if (node.parallelGateway &&
      stableStringify(node.parallelGateway) !== stableStringify(actualNode.parallelGateway || {})) {
      diagnostics.push(mismatch("workflow", "readback.workflow.parallel_gateway_mismatch", "Readback parallel-gateway configuration mismatch.", {
        invariantKey: `workflow.nodes.${node.id}.parallelGateway`,
        path: `/readback/workflow/nodes/${node.id}/parallelGateway`,
        expected: node.parallelGateway,
        actual: actualNode.parallelGateway
      }));
    }
    if (node.dataAuthority) {
      if (stableStringify(node.dataAuthority) !== stableStringify(actualNode.dataAuthority || {})) {
        diagnostics.push(mismatch("workflow", "readback.workflow.data_authority_mismatch", "Readback workflow data authority mismatch.", {
          invariantKey: `workflow.nodes.${node.id}.dataAuthority`,
          path: `/readback/workflow/nodes/${node.id}/dataAuthority`,
          expected: node.dataAuthority,
          actual: actualNode.dataAuthority
        }));
      }
    }
    if (node.subProcess && stableStringify(node.subProcess) !== stableStringify(actualNode.subProcess || {})) {
      diagnostics.push(mismatch("workflow", "readback.workflow.subprocess_mismatch", "Readback subprocess native configuration mismatch.", {
        invariantKey: `workflow.nodes.${node.id}.subProcess`,
        path: `/readback/workflow/nodes/${node.id}/subProcess`,
        expected: node.subProcess,
        actual: actualNode.subProcess
      }));
    }
  }
  for (const node of actual.nodes || []) {
    if (!expectedNodeIds.has(node.id)) {
      diagnostics.push(mismatch("workflow", "readback.workflow.unexpected_node", "Readback workflow has an unexpected node.", {
        invariantKey: `workflow.nodes.${node.id}`,
        path: "/readback/workflow/nodes",
        details: { nodeId: node.id }
      }));
    }
  }

  const actualEdges = new Map((actual.edges || []).map((edge) => [edge.id, edge]));
  const expectedEdgeIds = new Set((expected.edges || []).map((edge) => edge.id));
  for (const edge of expected.edges || []) {
    const actualEdge = actualEdges.get(edge.id);
    if (!actualEdge) {
      diagnostics.push(mismatch("workflow", "readback.workflow.edge_missing", "Readback workflow is missing a DSL edge.", {
        invariantKey: `workflow.edges.${edge.id}`,
        path: "/readback/workflow/edges",
        details: { edgeId: edge.id }
      }));
      continue;
    }
    if (actualEdge.source !== edge.source || actualEdge.target !== edge.target) {
      diagnostics.push(mismatch("workflow", "readback.workflow.edge_endpoint_mismatch", "Readback workflow edge endpoints do not match DSL.", {
        invariantKey: `workflow.edges.${edge.id}.endpoints`,
        path: `/readback/workflow/edges/${edge.id}`,
        expected: { source: edge.source, target: edge.target },
        actual: { source: actualEdge.source, target: actualEdge.target }
      }));
    }
    if (Boolean(edge.isDefault) !== Boolean(actualEdge.isDefault)) {
      diagnostics.push(mismatch("workflow", "readback.workflow.edge_default_mismatch", "Readback workflow default-route ownership mismatch.", {
        invariantKey: `workflow.edges.${edge.id}.isDefault`,
        path: `/readback/workflow/edges/${edge.id}/isDefault`,
        expected: edge.isDefault,
        actual: actualEdge.isDefault
      }));
    }
    if (edge.condition?.nativeRequired) {
      compareNativeEdgeCondition(edge, actualEdge, diagnostics);
    } else if (edge.condition?.text) {
      const actualText = actualEdge.condition?.text || "";
      if (actualEdge.condition?.nativeStatus === "ok" && actualEdge.condition?.nativeKind === "batch_formula") {
        // Source text is projected into NewOA formula designer JSON; text is not persisted on the edge.
      } else if (!actualText || normalizeScalar(actualText) !== normalizeScalar(edge.condition.text)) {
        if (!String(actualText).includes(String(edge.condition.text))) {
          diagnostics.push(mismatch("workflow", "readback.workflow.edge_condition_mismatch", "Readback workflow edge condition mismatch.", {
            invariantKey: `workflow.edges.${edge.id}.condition`,
            path: `/readback/workflow/edges/${edge.id}/condition`,
            expected: edge.condition.text,
            actual: actualText
          }));
        }
      }
    }
  }
  for (const edge of actual.edges || []) {
    if (!expectedEdgeIds.has(edge.id)) {
      diagnostics.push(mismatch("workflow", "readback.workflow.unexpected_edge", "Readback workflow has an unexpected edge.", {
        invariantKey: `workflow.edges.${edge.id}`,
        path: "/readback/workflow/edges",
        details: { edgeId: edge.id }
      }));
    }
  }
}

function participantsEquivalent(expected, actual) {
  if (stableStringify(expected) === stableStringify(actual || {})) return true;
  if (expected?.mode !== "explicit" || actual?.mode !== "initiator_select") return false;
  const comparableKeys = [
    "handlersType",
    "handlersSource",
    "handlersRuleKey",
    "handlersRuleName",
    "handlersElement",
    "members"
  ];
  const expectedComparable = Object.fromEntries(comparableKeys.map((key) => [key, expected?.[key]]));
  const actualComparable = Object.fromEntries(comparableKeys.map((key) => [key, actual?.[key]]));
  return stableStringify(expectedComparable) === stableStringify(actualComparable);
}

function assertEqual(diagnostics, partition, code, invariantKey, expected, actual, path) {
  if (normalizeScalar(expected) === normalizeScalar(actual)) return;
  diagnostics.push(mismatch(partition, code, `Readback ${invariantKey} mismatch.`, {
    invariantKey,
    path,
    expected,
    actual
  }));
}

function compareNativeEdgeCondition(edge, actualEdge, diagnostics) {
  const actual = actualEdge.condition;
  const expectedKind = edge.condition.nativeKind;
  if (!actual || actual.nativeStatus === "missing") {
    diagnostics.push(mismatch("workflow", "readback.workflow.edge_condition_native_missing", "Readback workflow edge is missing its native condition formula.", {
      invariantKey: `workflow.edges.${edge.id}.condition.native`,
      path: `/readback/workflow/edges/${edge.id}/condition`,
      expected: { nativeRequired: true, nativeKind: expectedKind },
      actual: actual || null
    }));
    return;
  }
  if (actual.nativeStatus === "corrupt") {
    diagnostics.push(mismatch("workflow", "readback.workflow.edge_condition_native_corrupt", "Readback workflow edge native condition formula is corrupt.", {
      invariantKey: `workflow.edges.${edge.id}.condition.native`,
      path: `/readback/workflow/edges/${edge.id}/condition`,
      expected: { nativeRequired: true, nativeKind: expectedKind },
      actual
    }));
    return;
  }
  if (actual.nativeStatus !== "ok") {
    diagnostics.push(mismatch("workflow", "readback.workflow.edge_condition_native_corrupt", "Readback workflow edge native condition status is invalid.", {
      invariantKey: `workflow.edges.${edge.id}.condition.native`,
      path: `/readback/workflow/edges/${edge.id}/condition`,
      expected: { nativeStatus: "ok", nativeKind: expectedKind },
      actual
    }));
    return;
  }
  if (actual.hasForbiddenLiteral) {
    diagnostics.push(mismatch("workflow", "readback.workflow.edge_condition_native_forbidden_literal", "Readback workflow edge native condition contains a forbidden literal.", {
      invariantKey: `workflow.edges.${edge.id}.condition.native`,
      path: `/readback/workflow/edges/${edge.id}/condition`,
      expected: { forbiddenLiteral: false },
      actual: { hasForbiddenLiteral: true }
    }));
    return;
  }
  if (expectedKind && actual.nativeKind && expectedKind !== actual.nativeKind) {
    diagnostics.push(mismatch("workflow", "readback.workflow.edge_condition_native_corrupt", "Readback workflow edge native condition kind mismatch.", {
      invariantKey: `workflow.edges.${edge.id}.condition.nativeKind`,
      path: `/readback/workflow/edges/${edge.id}/condition`,
      expected: expectedKind,
      actual: actual.nativeKind
    }));
    return;
  }

  if (edge.condition.nativeText && edge.condition.nativeText !== actual.nativeText) {
    diagnostics.push(mismatch("workflow", "readback.workflow.edge_condition_native_semantic_mismatch", "Readback workflow edge native rule condition changed.", {
      invariantKey: `workflow.edges.${edge.id}.condition.nativeText`,
      path: `/readback/workflow/edges/${edge.id}/condition/nativeText`,
      expected: edge.condition.nativeText,
      actual: actual.nativeText || ""
    }));
    return;
  }

  const expectedSemantics = edge.condition.nativeSemantics;
  if (expectedSemantics) {
    const actualSemantics = Object.fromEntries(
      Object.keys(expectedSemantics).map((key) => [key, actual[key]])
    );
    if (stableStringify(expectedSemantics) !== stableStringify(actualSemantics)) {
      diagnostics.push(mismatch("workflow", "readback.workflow.edge_condition_native_semantic_mismatch", "Readback workflow edge native condition semantics changed.", {
        invariantKey: `workflow.edges.${edge.id}.condition.nativeSemantics`,
        path: `/readback/workflow/edges/${edge.id}/condition`,
        expected: expectedSemantics,
        actual: actualSemantics
      }));
      return;
    }
  }

  const expectedSourceText = normalizeScalar(edge.condition.sourceText || "");
  const actualSourceText = normalizeScalar(actual.provenance?.sourceText || "");
  if (expectedSourceText && actualSourceText && expectedSourceText !== actualSourceText) {
    diagnostics.push(diagnostic({
      level: "warning",
      code: "readback.workflow.edge_condition_provenance_mismatch",
      message: "Readback workflow edge condition provenance text differs from the DSL source text.",
      partition: "workflow",
      invariantKey: `workflow.edges.${edge.id}.condition.provenance`,
      path: `/readback/workflow/edges/${edge.id}/condition/provenance`,
      expected: expectedSourceText,
      actual: actualSourceText
    }));
  }
}

function mismatch(partition, code, message, options = {}) {
  return diagnostic({
    level: "error",
    code,
    message,
    partition,
    invariantKey: options.invariantKey,
    path: options.path,
    expected: options.expected,
    actual: options.actual,
    details: options.details
  });
}
