import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { sampleDraftDsl, sampleForm, sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("validateMigrationDsl", () => {
  it("accepts the sample trusted migration DSL", () => {
    const result = validateMigrationDsl(sampleTrustedDsl(), { mode: "execute" });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.diagnostics, []);
  });

  it("accepts a non-executable dsl-draft only at the draft boundary", () => {
    const draft = sampleDraftDsl();
    const draftCheck = validateMigrationDsl(draft, { mode: "draft" });
    const executeCheck = validateMigrationDsl(draft, { mode: "execute" });

    assert.equal(draftCheck.ok, true);
    assert.equal(draftCheck.status, "ok");
    assert.equal(executeCheck.ok, false);
    assert.equal(executeCheck.diagnostics.some((item) => item.code === "dsl.trust.trusted_required"), true);
  });

  it("rejects missing template names", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({ template: { name: "" } }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.template.name_required"), true);
  });

  it("rejects field and detail-column ids longer than the MK 25-character limit", () => {
    const dsl = sampleTrustedDsl();
    dsl.form.fields[0].id = "fd_attention_row__description";
    dsl.form.fields[2].columns[0].id = "fd_detail_column_name_over_limit";
    const result = validateMigrationDsl(dsl, { mode: "execute" });
    const diagnostics = result.diagnostics.filter((item) => item.code === "dsl.field.id_too_long");

    assert.equal(result.ok, false);
    assert.deepEqual(diagnostics.map((item) => item.details.id), [
      "fd_attention_row__description",
      "fd_detail_column_name_over_limit"
    ]);
    assert.equal(diagnostics.every((item) => item.details.maxLength === 25), true);
  });

  it("rejects unknown components, unknown props, invalid prop values, and unsupported functions", () => {
    const dsl = sampleTrustedDsl({
      form: {
        fields: [
          {
            id: "fd_subject",
            title: "主题",
            type: "longText",
            componentId: "xform-textarea",
            props: { maxLength: 0, unknownProp: true },
            sourceProps: {},
            sourceRef: "source.form.control.fd_subject"
          },
          {
            id: "fd_detail",
            title: "明细",
            type: "detailTable",
            componentId: "xform-detail-table",
            props: {},
            sourceProps: {},
            sourceRef: "source.form.detailTable.fd_detail",
            columns: [
              {
                id: "fd_name",
                title: "名称",
                type: "text",
                componentId: "xform-not-real",
                props: {},
                sourceProps: {},
                sourceRef: "source.form.detailTable.fd_detail.column.fd_name"
              }
            ]
          }
        ]
      },
      review: {
        warnings: [],
        decisions: [],
        functionWhitelist: {
          violations: [{ name: "UnknownLegacyFunction", occurrences: [] }]
        }
      }
    });
    const result = validateMigrationDsl(dsl, { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "catalog.props.unknown"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "catalog.props.value_invalid"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "catalog.component_unknown"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "catalog.function_unsupported"), true);
  });

  it("rejects trusted layouts without mkTree and invalid child references", () => {
    const missingTree = validateMigrationDsl(sampleTrustedDsl({ form: { layout: { mkTree: [] } } }), { mode: "execute" });
    const missingField = validateMigrationDsl(sampleTrustedDsl({
      form: {
        layout: {
          mkTree: [{
            id: "layout.row-0",
            componentId: "xform-flex-1-1-layout",
            props: { columns: 1 },
            sourceRef: "source.form.layout.row.row-0",
            children: [{ id: "child", refType: "field", refIds: ["fd_missing"], sourceRef: "source.form.layout.cell.row-0-cell-0" }]
          }]
        }
      }
    }), { mode: "execute" });

    assert.equal(missingTree.ok, false);
    assert.equal(missingTree.diagnostics.some((item) => item.code === "dsl.form.layout.mk_tree_required"), true);
    assert.equal(missingField.ok, false);
    assert.equal(missingField.diagnostics.some((item) => item.code === "dsl.form.layout.field_missing"), true);
  });

  it("requires JSP script actions to be reviewed before execution", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      scripts: {
        actions: [{
          id: "fd_jsp.script.1",
          name: "onLoad",
          event: "onLoad",
          function: "function onLoad(context) {}",
          translationStatus: "needs_review"
        }]
      }
    }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.scripts.needs_review"), true);
  });

  it("keeps unresolved pending script targets reviewable in draft only", () => {
    const pendingAction = {
      id: "fd_jsp.script.1",
      name: "onChange",
      event: "onChange",
      scope: "control",
      controlId: "fd_missing",
      function: "function onChange(value) {}",
      translationStatus: "needs_review",
      coverage: { status: "uncovered", nativeRules: [], residuals: [] },
      functionMappings: []
    };
    const draft = validateMigrationDsl(sampleDraftDsl({
      workflow: undefined,
      scripts: { actions: [pendingAction] }
    }), { mode: "draft" });
    const executable = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: { actions: [pendingAction] }
    }), { mode: "execute" });
    const omitted = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [{
          ...pendingAction,
          function: "",
          translationStatus: "omitted",
          coverage: { status: "covered", nativeRules: ["linkage.fd_subject.contains.A"], residuals: [] }
        }]
      }
    }), { mode: "execute" });

    assert.equal(draft.ok, true);
    assert.equal(draft.diagnostics.some((item) => item.code === "dsl.scripts.control_unresolved_pending_review"), true);
    assert.equal(executable.ok, false);
    assert.equal(executable.diagnostics.some((item) => item.code === "dsl.scripts.control_unresolved"), true);
    assert.equal(executable.diagnostics.some((item) => item.code === "dsl.scripts.needs_review"), true);
    assert.equal(omitted.ok, true);
  });

  it("accepts supported global after-submit scripts and blocks DOM-based mapped scripts", () => {
    const accepted = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [{
          id: "after-submit.1",
          name: "onAfterSubmit",
          event: "onAfterSubmit",
          scope: "global",
          function: "function onAfterSubmit() {\n  MKXFORM.setValue('fd_subject', 'done')\n}",
          translationStatus: "mapped",
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          functionMappings: [{
            source: "SetXFormFieldValueById",
            target: "MKXFORM.setValue",
            basis: "semantic-translation",
            reviewRequired: false
          }]
        }]
      }
    }), { mode: "execute" });
    const rejected = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [{
          id: "change.1",
          name: "onChange",
          event: "onChange",
          scope: "control",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  document.getElementById('fd_subject').value = value\n}",
          translationStatus: "mapped",
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          functionMappings: [{
            source: "DOM value assignment",
            target: "blocked DOM usage",
            basis: "semantic-translation",
            reviewRequired: true
          }]
        }]
      }
    }), { mode: "execute" });

    assert.equal(accepted.ok, true);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.diagnostics.some((item) => item.code === "dsl.scripts.dom_api_forbidden"), true);
  });

  it("warns for detail-table onChange scripts until detail-column event support is verified", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [{
          id: "fd_detail.fd_name.onChange.1",
          name: "onChange",
          event: "onChange",
          scope: "control",
          tableId: "fd_detail",
          controlId: "fd_name",
          function: "function onChange(value, rowNum, parentRowNum) {\n  MKXFORM.updateControlStyle(\"${table:fd_detail}.fd_name\", rowNum, { display: value === \"gh\" ? \"block\" : \"none\" })\n}",
          translationStatus: "mapped",
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          functionMappings: [{
            source: "detail-row DOM display toggle",
            target: "MKXFORM.updateControlStyle",
            basis: "semantic-translation",
            reviewRequired: false
          }]
        }]
      }
    }), { mode: "any" });

    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.scripts.control_event_unknown" && item.level === "warning"), true);
  });

  it("validates control script events against the MK control-events catalog", () => {
    const accepted = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      form: selectForm(),
      scripts: {
        actions: [
          mappedAction({ id: "fd_subject.onFocus", name: "onFocus", event: "onFocus", controlId: "fd_subject", function: "function onFocus() {\n  MKXFORM.setValue('fd_amount', 'focused')\n}" }),
          mappedAction({ id: "fd_amount.onBlur", name: "onBlur", event: "onBlur", controlId: "fd_amount", function: "function onBlur() {\n  MKXFORM.setValue('fd_subject', 'blurred')\n}" }),
          mappedAction({ id: "fd_select.onSelect", name: "onSelect", event: "onSelect", controlId: "fd_select", function: "function onSelect() {\n  MKXFORM.setValue('fd_subject', 'selected')\n}" }),
          mappedAction({ id: "fd_select.onDelect", name: "onDelect", event: "onDelect", controlId: "fd_select", function: "function onDelect() {\n  MKXFORM.setValue('fd_subject', 'deleted')\n}" })
        ]
      }
    }), { mode: "execute" });
    const acceptedDetailSelect = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      form: detailSelectForm(),
      scripts: {
        actions: [mappedAction({
          id: "fd_detail.fd_choice.onChange",
          tableId: "fd_detail",
          controlId: "fd_choice",
          coverage: { status: "translated", nativeRules: [], residuals: [] }
        })]
      }
    }), { mode: "execute" });

    const rejectedSubject = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      form: subjectForm(),
      scripts: {
        actions: [mappedAction({ id: "fd_subject.onChange", event: "onChange", controlId: "fd_subject" })]
      }
    }), { mode: "execute" });

    const rejectedDetailUnknown = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [mappedAction({ id: "fd_detail.fd_name.onChange", tableId: "fd_detail", controlId: "fd_name" })]
      }
    }), { mode: "execute" });

    const draftDetailUnknown = validateMigrationDsl(sampleDraftDsl({
      scripts: {
        actions: [mappedAction({ id: "fd_detail.fd_name.onChange", tableId: "fd_detail", controlId: "fd_name" })]
      }
    }), { mode: "draft" });

    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.diagnostics, []);
    assert.equal(acceptedDetailSelect.ok, true);
    assert.deepEqual(acceptedDetailSelect.diagnostics, []);
    assert.equal(rejectedSubject.ok, false);
    assert.equal(rejectedSubject.diagnostics.some((item) => item.code === "dsl.scripts.control_event_unsupported"), true);
    assert.equal(rejectedDetailUnknown.ok, false);
    assert.equal(rejectedDetailUnknown.diagnostics.some((item) => item.code === "dsl.scripts.control_event_unknown" && item.level === "error"), true);
    assert.equal(draftDetailUnknown.ok, true);
    assert.equal(draftDetailUnknown.diagnostics.some((item) => item.code === "dsl.scripts.control_event_unknown" && item.level === "warning"), true);
  });

  it("validates mapped script calls against the MK JS-method catalog", () => {
    const accepted = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [mappedAction({
          id: "fd_subject.catalogedJs",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  var text = String(value).trim()\n  MKXFORM.setValue('fd_amount', JSON.stringify({ value: text }))\n}"
        })]
      }
    }), { mode: "execute" });
    const rejected = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [mappedAction({
          id: "fd_subject.unsupportedJs",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  var cached = localStorage.getItem('fd_subject')\n  MKXFORM.setValue('fd_amount', cached || value)\n}"
        })]
      }
    }), { mode: "execute" });

    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.diagnostics, []);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.diagnostics.some((item) => item.code === "dsl.scripts.call_unsupported"), true);
    assert.equal(
      rejected.diagnostics.some((item) => item.details?.calls?.some((call) => call.name === "localStorage.getItem")),
      true
    );
  });

  it("requires coverage and mapping evidence for every mapped script", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [mappedAction({
          id: "fd_subject.safe_api_without_evidence",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  MKXFORM.setValue('fd_amount', value)\n}",
          coverage: { status: "none", nativeRules: [], residuals: [] },
          functionMappings: []
        })]
      }
    }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.scripts.mapped_coverage_status_invalid"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.scripts.mapped_function_mappings_required"), true);
  });

  it("requires translated coverage and mappings for review-grade target APIs", () => {
    const accepted = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [mappedAction({
          id: "fd_subject.message",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  if (!value) MKXFORM.message.success('请输入主题')\n}",
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          functionMappings: [{
            source: "alert",
            target: "MKXFORM.message.success",
            basis: "target-api-catalog",
            reviewRequired: true
          }]
        })]
      }
    }), { mode: "execute" });
    const rejected = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [mappedAction({
          id: "fd_subject.message.no_evidence",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  if (!value) MKXFORM.message.success('请输入主题')\n}",
          coverage: { status: "none", nativeRules: [], residuals: [] },
          functionMappings: []
        })]
      }
    }), { mode: "execute" });

    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.diagnostics, []);
    assert.equal(rejected.ok, false);
    assert.equal(
      rejected.diagnostics.some((item) =>
        item.code === "dsl.scripts.review_target_api_evidence_required" ||
        item.code === "dsl.scripts.mapped_function_mappings_required" ||
        item.code === "dsl.scripts.mapped_coverage_status_invalid"
      ),
      true
    );
  });

  it("rejects blocked and unknown MKXFORM target APIs in mapped scripts", () => {
    const blocked = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [mappedAction({
          id: "fd_subject.execute_operation",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  MKXFORM.executeOperation({})\n}"
        })]
      }
    }), { mode: "execute" });
    const unknown = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [mappedAction({
          id: "fd_subject.unknown_api",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  MKXFORM.notInCatalog(value)\n}"
        })]
      }
    }), { mode: "execute" });

    assert.equal(blocked.ok, false);
    assert.equal(blocked.diagnostics.some((item) => item.code === "dsl.scripts.target_api_unsupported"), true);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.diagnostics.some((item) => item.code === "dsl.scripts.target_api_unsupported"), true);
  });

  it("accepts only setFieldAttr targets that are actually persisted", () => {
    const form = sampleForm();
    form.layout.mkTree[1] = {
      ...form.layout.mkTree[1],
      sourceMarkers: ["fd_detail_row", "fd_detail_row_alias"]
    };

    const rejectedTablePlaceholder = validateMigrationDsl(sampleTrustedDsl({
      form,
      workflow: undefined,
      scripts: {
        actions: [mappedAction({
          id: "fd_subject.table_placeholder",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  MKXFORM.setFieldAttr(\"${table:fd_detail}\", value ? 5 : 4)\n}",
          functionMappings: [{
            source: "common_dom_row_set_show_required_reset",
            target: "MKXFORM.setFieldAttr",
            basis: "semantic-translation",
            reviewRequired: false
          }]
        })]
      }
    }), { mode: "execute" });

    const rejectedDetailId = validateMigrationDsl(sampleTrustedDsl({
      form,
      workflow: undefined,
      scripts: {
        actions: [mappedAction({
          id: "fd_subject.detail_id",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  MKXFORM.setFieldAttr(\"fd_detail\", value ? 5 : 4)\n}",
          functionMappings: [{
            source: "common_dom_row_set_show_required_reset",
            target: "MKXFORM.setFieldAttr",
            basis: "semantic-translation",
            reviewRequired: false
          }]
        })]
      }
    }), { mode: "execute" });

    const acceptedMarker = validateMigrationDsl(sampleTrustedDsl({
      form,
      workflow: undefined,
      scripts: {
        actions: [mappedAction({
          id: "fd_subject.row_marker",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  MKXFORM.setFieldAttr(\"fd_detail_row\", value ? 5 : 4)\n}",
          functionMappings: [{
            source: "common_dom_row_set_show_required_reset",
            target: "MKXFORM.setFieldAttr",
            basis: "semantic-translation",
            reviewRequired: false
          }]
        })]
      }
    }), { mode: "execute" });

    const rejectedRowId = validateMigrationDsl(sampleTrustedDsl({
      form,
      workflow: undefined,
      scripts: {
        actions: [mappedAction({
          id: "fd_subject.row_id",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  MKXFORM.setFieldAttr(\"layout.row-1\", value ? 5 : 4)\n}",
          functionMappings: [{
            source: "common_dom_row_set_show_required_reset",
            target: "MKXFORM.setFieldAttr",
            basis: "semantic-translation",
            reviewRequired: false
          }]
        })]
      }
    }), { mode: "execute" });

    const rejectedSecondaryMarker = validateMigrationDsl(sampleTrustedDsl({
      form,
      workflow: undefined,
      scripts: {
        actions: [mappedAction({
          id: "fd_subject.secondary_marker",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  MKXFORM.setFieldAttr(\"fd_detail_row_alias\", value ? 5 : 4)\n}",
          functionMappings: [{
            source: "common_dom_row_set_show_required_reset",
            target: "MKXFORM.setFieldAttr",
            basis: "semantic-translation",
            reviewRequired: false
          }]
        })]
      }
    }), { mode: "execute" });

    const rejectedDynamicTarget = validateMigrationDsl(sampleTrustedDsl({
      form,
      workflow: undefined,
      scripts: {
        actions: [mappedAction({
          id: "fd_subject.dynamic_target",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  const rowId = \"fd_detail_row\"\n  MKXFORM.setFieldAttr(rowId, value ? 5 : 4)\n}",
          functionMappings: [{
            source: "common_dom_row_set_show_required_reset",
            target: "MKXFORM.setFieldAttr",
            basis: "semantic-translation",
            reviewRequired: false
          }]
        })]
      }
    }), { mode: "execute" });

    assert.equal(rejectedTablePlaceholder.ok, false);
    assert.equal(rejectedTablePlaceholder.diagnostics.some((item) => item.code === "dsl.scripts.set_field_attr_target_invalid"), true);
    assert.equal(rejectedDetailId.ok, false);
    assert.equal(rejectedDetailId.diagnostics.some((item) => item.code === "dsl.scripts.set_field_attr_target_invalid"), true);
    assert.equal(acceptedMarker.ok, true);
    assert.equal(rejectedRowId.ok, false);
    assert.equal(rejectedRowId.diagnostics.some((item) => item.code === "dsl.scripts.set_field_attr_target_invalid"), true);
    assert.equal(rejectedSecondaryMarker.ok, false);
    assert.equal(rejectedSecondaryMarker.diagnostics.some((item) => item.code === "dsl.scripts.set_field_attr_target_invalid"), true);
    assert.equal(
      rejectedSecondaryMarker.diagnostics.some((item) =>
        item.details?.issues?.some((issue) => issue.code === "secondary_marker" && issue.primary === "fd_detail_row")
      ),
      true
    );
    assert.equal(rejectedDynamicTarget.ok, false);
    assert.equal(rejectedDynamicTarget.diagnostics.some((item) => item.code === "dsl.scripts.set_field_attr_target_invalid"), true);
  });

  it("requires before-submit scripts to handle draft saves and return explicitly", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [{
          id: "before-submit.1",
          name: "onBeforeSubmit",
          event: "onBeforeSubmit",
          scope: "global",
          function: "function onBeforeSubmit(context) {\n  MKXFORM.validateFields()\n}",
          translationStatus: "mapped",
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          functionMappings: [{
            source: "before submit validation",
            target: "MKXFORM.validateFields",
            basis: "semantic-translation",
            reviewRequired: false
          }]
        }]
      }
    }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.scripts.before_submit_return_required"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.scripts.before_submit_draft_guard_required"), true);
  });

  it("rejects executable form linkage rules with unresolved condition fields or effect targets", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      formRules: {
        linkage: [
          {
            id: "linkage.missing.condition",
            trigger: "change",
            source: "fd_missing",
            logic: "and",
            when: [{ field: "fd_missing", op: "contains", value: "A" }],
            effects: [{ type: "visible", target: "fd_subject", value: true }],
            else: [{ type: "visible", target: "fd_subject", value: false }],
            translationStatus: "executable"
          },
          {
            id: "linkage.missing.target",
            trigger: "change",
            source: "fd_subject",
            logic: "and",
            when: [{ field: "fd_subject", op: "eq", value: "A" }],
            effects: [{ type: "required", target: "fd_missing_row", value: true }],
            else: [{ type: "required", target: "fd_missing_row", value: false }],
            translationStatus: "executable"
          }
        ],
        validations: [],
        impliedRequired: [],
        review: {}
      }
    }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.form_rules.condition_field_unresolved"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.form_rules.effect_target_unresolved"), true);
  });

  it("rejects invalid workflow DAGs and initiator selection without source semantics", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      workflow: {
        nodes: [
          { id: "N1", type: "generalStart", element: "startEvent", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
          { id: "N2", type: "review", element: "manualTask", sourceRef: "source.workflow.node.N2", attributes: {}, participants: { mode: "initiator_select" }, translationStatus: "executable" },
          { id: "N3", type: "generalEnd", element: "endEvent", sourceRef: "source.workflow.node.N3", attributes: {}, translationStatus: "executable" }
        ],
        edges: [{ id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } }],
        topologicalOrder: ["N1", "N2", "N3"]
      }
    }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.workflow.node_cannot_reach_end"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "workflow.participants.initiator_select_without_source"), true);
  });

  it("rejects a formula-selected source node forged as explicit participants", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      workflow: {
        process: { id: "process-formula-forged-explicit" },
        nodes: [
          { id: "N1", type: "generalStart", element: "startEvent", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
          {
            id: "N2",
            type: "review",
            element: "manualTask",
            sourceRef: "source.workflow.node.N2",
            attributes: {
              handlerSelectType: "formula",
              handlerIds: "import java.util.List; return handlers;",
              handlerNames: "复杂公式"
            },
            participants: {
              mode: "explicit",
              members: [{ id: "import java.util.List", name: "import java.util.List", type: "user_or_org" }]
            },
            translationStatus: "executable"
          },
          { id: "N3", type: "generalEnd", element: "endEvent", sourceRef: "source.workflow.node.N3", attributes: {}, translationStatus: "executable" }
        ],
        edges: [
          { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
          { id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2", condition: { translationStatus: "executable" } }
        ],
        topologicalOrder: ["N1", "N2", "N3"]
      }
    }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(
      result.diagnostics.some((item) => item.code === "workflow.participants.formula_unmapped"),
      true
    );
  });

  it("accepts form-field workflow participants only when the field exists", () => {
    const workflow = {
      process: { id: "process-form-field-handler" },
      nodes: [
        { id: "N1", type: "generalStart", element: "startEvent", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
        {
          id: "N2",
          type: "review",
          element: "manualTask",
          sourceRef: "source.workflow.node.N2",
          attributes: { handlerIds: "$fd_subject$", handlerNames: "$主题$", handlerSelectType: "formula" },
          participants: {
            mode: "form_field",
            fieldId: "fd_subject",
            fieldTitle: "主题",
            sourceExpression: "$fd_subject$",
            sourceNameExpression: "$主题$"
          },
          translationStatus: "executable"
        },
        { id: "N3", type: "generalEnd", element: "endEvent", sourceRef: "source.workflow.node.N3", attributes: {}, translationStatus: "executable" }
      ],
      edges: [
        { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
        { id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2", condition: { translationStatus: "executable" } }
      ],
      topologicalOrder: ["N1", "N2", "N3"]
    };
    const accepted = validateMigrationDsl(sampleTrustedDsl({ workflow }), { mode: "execute" });
    const rejected = validateMigrationDsl(sampleTrustedDsl({
      workflow: {
        ...workflow,
        nodes: workflow.nodes.map((node) => node.id === "N2"
          ? { ...node, participants: { ...node.participants, fieldId: "fd_missing", sourceExpression: "$fd_missing$" } }
          : node)
      }
    }), { mode: "execute" });

    assert.equal(accepted.ok, true);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.diagnostics.some((item) => item.code === "workflow.participants.form_field_missing"), true);
  });

  it("accepts person-by-login-name workflow participants only when the field exists", () => {
    const workflow = {
      process: { id: "process-person-by-login-name" },
      nodes: [
        { id: "N1", type: "generalStart", element: "startEvent", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
        {
          id: "N2",
          type: "review",
          element: "manualTask",
          sourceRef: "source.workflow.node.N2",
          attributes: {
            handlerIds: "$组织架构.根据登录名取用户$($fd_subject$)",
            handlerNames: "$组织架构.根据登录名取用户$($主题$)",
            handlerSelectType: "formula"
          },
          participants: {
            mode: "person_by_login_name",
            fieldId: "fd_subject",
            fieldTitle: "主题",
            sourceExpression: "$组织架构.根据登录名取用户$($fd_subject$)",
            sourceNameExpression: "$组织架构.根据登录名取用户$($主题$)"
          },
          translationStatus: "executable"
        },
        { id: "N3", type: "generalEnd", element: "endEvent", sourceRef: "source.workflow.node.N3", attributes: {}, translationStatus: "executable" }
      ],
      edges: [
        { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
        { id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2", condition: { translationStatus: "executable" } }
      ],
      topologicalOrder: ["N1", "N2", "N3"]
    };
    const accepted = validateMigrationDsl(sampleTrustedDsl({ workflow }), { mode: "execute" });
    const rejected = validateMigrationDsl(sampleTrustedDsl({
      workflow: {
        ...workflow,
        nodes: workflow.nodes.map((node) => node.id === "N2"
          ? { ...node, participants: { ...node.participants, fieldId: "fd_missing", sourceExpression: "$组织架构.根据登录名取用户$($fd_missing$)" } }
          : node)
      }
    }), { mode: "execute" });

    assert.equal(accepted.ok, true);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.diagnostics.some((item) => item.code === "workflow.participants.person_by_login_name_missing"), true);

    const unknownModeDsl = sampleTrustedDsl({
      workflow: {
        ...workflow,
        nodes: workflow.nodes.map((node) => node.id === "N2"
          ? { ...node, participants: { ...node.participants, mode: "person_by_login_nam" } }
          : node)
      }
    });
    const unknownMode = validateMigrationDsl(unknownModeDsl, { mode: "execute" });
    assert.equal(unknownMode.ok, false);
    assert.equal(
      unknownMode.diagnostics.some((item) => item.code === "workflow.participants.mode_unsupported"),
      true
    );

    const invalidTypeDsl = sampleTrustedDsl({
      workflow: {
        ...workflow,
        nodes: workflow.nodes.map((node) => node.id === "N2"
          ? { ...node, participants: "person_by_login_name" }
          : node)
      }
    });
    const invalidType = validateMigrationDsl(invalidTypeDsl, { mode: "execute" });
    assert.equal(invalidType.ok, false);
    assert.equal(
      invalidType.diagnostics.some((item) => item.code === "workflow.participants.type"),
      true
    );
  });

  it("validates node data authority field references and flags", () => {
    const acceptedDsl = sampleTrustedDsl();
    acceptedDsl.workflow.nodes[0] = {
      ...acceptedDsl.workflow.nodes[0],
      dataAuthority: {
        enabled: true,
        fields: {
          fd_name: {
            visible: true,
            editable: false,
            required: false,
            sourceMode: "view",
            sourceRef: "source.form.dataAuthority.fdDisplayJsp.xform-right-1.N1.fd_name"
          }
        }
      }
    };
    const rejectedDsl = sampleTrustedDsl();
    rejectedDsl.workflow.nodes[0] = {
      ...rejectedDsl.workflow.nodes[0],
      dataAuthority: {
        enabled: true,
        fields: {
          fd_missing: {
            visible: true,
            editable: false
          }
        }
      }
    };

    const accepted = validateMigrationDsl(acceptedDsl, { mode: "execute" });
    const rejected = validateMigrationDsl(rejectedDsl, { mode: "execute" });

    assert.equal(accepted.ok, true);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.diagnostics.some((item) => item.code === "dsl.workflow.data_authority.field_missing"), true);
    assert.equal(rejected.diagnostics.some((item) => item.code === "dsl.workflow.data_authority.flag_required"), true);
  });

  it("validates role-line field and node-handler subjects", () => {
    const workflow = {
      process: { id: "process-role-line-handler" },
      nodes: [
        { id: "N1", type: "generalStart", element: "startEvent", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
        {
          id: "N2",
          type: "review",
          element: "manualTask",
          sourceRef: "source.workflow.node.N2",
          attributes: {
            handlerIds: "$组织架构.解释角色线$($fd_subject$, \"公司级部门领导\", \"部门领导\")",
            handlerNames: "$组织架构.解释角色线$($主题$, \"公司级部门领导\", \"部门领导\")",
            handlerSelectType: "formula"
          },
          participants: {
            mode: "role_line",
            subjectKind: "field",
            fieldId: "fd_subject",
            fieldTitle: "主题",
            companyRole: "公司级部门领导",
            departmentRole: "部门领导",
            sourceExpression: "$组织架构.解释角色线$($fd_subject$, \"公司级部门领导\", \"部门领导\")",
            sourceNameExpression: "$组织架构.解释角色线$($主题$, \"公司级部门领导\", \"部门领导\")"
          },
          translationStatus: "executable"
        },
        { id: "N3", type: "generalEnd", element: "endEvent", sourceRef: "source.workflow.node.N3", attributes: {}, translationStatus: "executable" }
      ],
      edges: [
        { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
        { id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2", condition: { translationStatus: "executable" } }
      ],
      topologicalOrder: ["N1", "N2", "N3"]
    };
    const accepted = validateMigrationDsl(sampleTrustedDsl({ workflow }), { mode: "execute" });
    const rejected = validateMigrationDsl(sampleTrustedDsl({
      workflow: {
        ...workflow,
        nodes: workflow.nodes.map((node) => node.id === "N2"
          ? { ...node, participants: { ...node.participants, fieldId: "fd_missing", sourceExpression: "$组织架构.解释角色线$($fd_missing$, \"公司级部门领导\", \"部门领导\")" } }
          : node)
      }
    }), { mode: "execute" });

    assert.equal(accepted.ok, true);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.diagnostics.some((item) => item.code === "workflow.participants.role_line_field_missing"), true);

    const nodeSubjectWorkflow = structuredClone(workflow);
    nodeSubjectWorkflow.nodes[1].attributes.handlerIds = "$组织架构.解释角色线$($流程.获取节点实际处理人$(\"N1\"), \"公司级部门领导\", \"部门领导\")";
    nodeSubjectWorkflow.nodes[1].attributes.handlerNames = "$组织架构.解释角色线$($流程.获取节点实际处理人$(\"N1\"), \"公司级部门领导\", \"部门领导\")";
    nodeSubjectWorkflow.nodes[1].participants = {
      mode: "role_line",
      subjectKind: "node_handlers",
      nodeId: "N1",
      subjectExpression: "$流程.获取节点实际处理人$(\"N1\")",
      companyRole: "公司级部门领导",
      departmentRole: "部门领导",
      sourceExpression: "$组织架构.解释角色线$($流程.获取节点实际处理人$(\"N1\"), \"公司级部门领导\", \"部门领导\")",
      sourceNameExpression: "$组织架构.解释角色线$($流程.获取节点实际处理人$(\"N1\"), \"公司级部门领导\", \"部门领导\")"
    };
    const acceptedNodeSubject = validateMigrationDsl(
      sampleTrustedDsl({ workflow: nodeSubjectWorkflow }),
      { mode: "execute" }
    );
    nodeSubjectWorkflow.nodes[1].participants.nodeId = "N404";
    const rejectedNodeSubject = validateMigrationDsl(
      sampleTrustedDsl({ workflow: nodeSubjectWorkflow }),
      { mode: "execute" }
    );

    assert.equal(acceptedNodeSubject.ok, true);
    assert.equal(rejectedNodeSubject.ok, false);
    assert.equal(
      rejectedNodeSubject.diagnostics.some((item) => item.code === "workflow.participants.role_line_node_missing"),
      true
    );

    const invalidKindWorkflow = structuredClone(workflow);
    invalidKindWorkflow.nodes[1].participants.subjectKind = "unknown";
    const invalidKind = validateMigrationDsl(
      sampleTrustedDsl({ workflow: invalidKindWorkflow }),
      { mode: "execute" }
    );
    assert.equal(invalidKind.ok, false);
    assert.equal(
      invalidKind.diagnostics.some((item) => item.code === "workflow.participants.role_line_subject_kind_unsupported"),
      true
    );

    const conflictingSubjectWorkflow = structuredClone(workflow);
    conflictingSubjectWorkflow.nodes[1].participants.nodeId = "N1";
    conflictingSubjectWorkflow.nodes[1].participants.subjectExpression = "$流程.获取节点实际处理人$(\"N1\")";
    const conflictingSubject = validateMigrationDsl(
      sampleTrustedDsl({ workflow: conflictingSubjectWorkflow }),
      { mode: "execute" }
    );
    assert.equal(conflictingSubject.ok, false);
    assert.equal(
      conflictingSubject.diagnostics.some((item) => item.code === "workflow.participants.role_line_subject_conflict"),
      true
    );
  });

  it("accepts executable all parallel split and join gateways", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      workflow: sampleParallelGatewayWorkflow()
    }), { mode: "execute" });

    assert.equal(result.ok, true);
  });

  it("accepts an executable condition split paired with an all join", () => {
    const workflow = sampleParallelGatewayWorkflow();
    workflow.nodes.find((node) => node.id === "N2").definition.attributes.splitType = "condition";
    const result = validateMigrationDsl(sampleTrustedDsl({ workflow }), { mode: "execute" });

    assert.equal(result.ok, true);
  });

  it("rejects executable parallel gateways without a single reciprocal related node", () => {
    const workflow = sampleParallelGatewayWorkflow();
    workflow.nodes.find((node) => node.id === "N2").attributes.relatedNodeIds = "N4;N5";
    workflow.nodes.find((node) => node.id === "N2").definition.attributes.relatedNodeIds = "N4;N5";
    const result = validateMigrationDsl(sampleTrustedDsl({ workflow }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.workflow.parallel_gateway.related_single_required"), true);
  });
});

function sampleParallelGatewayWorkflow() {
  return {
    process: { id: "process-parallel" },
    nodes: [
      { id: "N1", type: "generalStart", element: "startEvent", name: "开始", sourceType: "startNode", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
      { id: "N2", type: "split", element: "parallelGateway", name: "并行分支", sourceType: "splitNode", sourceRef: "source.workflow.node.N2", attributes: { relatedNodeIds: "N4" }, definition: { attributes: { splitType: "all", relatedNodeIds: "N4" } }, translationStatus: "executable" },
      { id: "N3", type: "review", element: "manualTask", name: "审批", sourceType: "reviewNode", sourceRef: "source.workflow.node.N3", attributes: { handlerIds: "handler-1", handlerNames: "审批人" }, participants: { mode: "explicit", members: [{ id: "handler-1", name: "审批人", type: "user_or_org" }] }, translationStatus: "executable" },
      { id: "N4", type: "join", element: "parallelGateway", name: "并行分支", sourceType: "joinNode", sourceRef: "source.workflow.node.N4", attributes: { relatedNodeIds: "N2" }, definition: { attributes: { joinType: "all", relatedNodeIds: "N2" } }, translationStatus: "executable" },
      { id: "N5", type: "generalEnd", element: "endEvent", name: "结束", sourceType: "endNode", sourceRef: "source.workflow.node.N5", attributes: {}, translationStatus: "executable" }
    ],
    edges: [
      { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
      { id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2", condition: { translationStatus: "executable" } },
      { id: "L3", source: "N3", target: "N4", sourceRef: "source.workflow.edge.L3", condition: { translationStatus: "executable" } },
      { id: "L4", source: "N4", target: "N5", sourceRef: "source.workflow.edge.L4", condition: { translationStatus: "executable" } }
    ],
    topologicalOrder: ["N1", "N2", "N3", "N4", "N5"]
  };
}

function mappedAction(overrides = {}) {
  const event = overrides.event || "onChange";
  const name = overrides.name || event;
  const fallbackFunction = overrides.tableId
    ? `function ${name}(value, rowNum) {\n  MKXFORM.setValue('fd_amount', value)\n}`
    : `function ${name}(value) {\n  MKXFORM.setValue('fd_amount', value)\n}`;
  return {
    id: overrides.id || `${overrides.controlId || "fd_subject"}.${event}`,
    name,
    event,
    scope: "control",
    controlId: overrides.controlId || "fd_subject",
    tableId: overrides.tableId,
    function: overrides.function || fallbackFunction,
    translationStatus: "mapped",
    coverage: overrides.coverage || { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: overrides.functionMappings || [{
      source: "legacy script behavior",
      target: "MKXFORM.setValue",
      basis: "semantic-translation",
      reviewRequired: false
    }]
  };
}

function selectForm() {
  const form = sampleForm();
  form.fields.splice(2, 0, {
    id: "fd_select",
    title: "选项",
    type: "singleSelect",
    componentId: "xform-select",
    props: {},
    sourceProps: { designerType: "select" },
    sourceRef: "source.form.control.fd_select"
  });
  form.layout.mkTree[0].children.push({
    id: "layout.row-0-cell-2",
    refType: "field",
    refIds: ["fd_select"],
    sourceRef: "source.form.layout.cell.row-0-cell-2",
    column: 2,
    colspan: 1
  });
  return form;
}

function detailSelectForm() {
  const form = sampleForm();
  form.fields[2].columns.push({
    id: "fd_choice",
    title: "选项",
    type: "singleSelect",
    componentId: "xform-select",
    props: {},
    sourceProps: { designerType: "select" },
    sourceRef: "source.form.detailTable.fd_detail.column.fd_choice"
  });
  return form;
}

function subjectForm() {
  const form = sampleForm();
  form.fields[0] = {
    ...form.fields[0],
    componentId: "xform-subject",
    sourceProps: { designerType: "subject" }
  };
  return form;
}
