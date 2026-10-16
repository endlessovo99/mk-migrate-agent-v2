import { integrityError } from "./integrity.js";
import { readFileSync } from "node:fs";
import { executionOptions } from "../../src/batch/contracts.js";

const SIGN_OPTIONS = JSON.parse(readFileSync(new URL("../fixtures/route-validation/workflow-sign/sign-policy.json", import.meta.url), "utf8"));
const SIGN_OPERATIONS = JSON.parse(readFileSync(new URL("../fixtures/route-validation/workflow-sign/operation-set.json", import.meta.url), "utf8"));

export const REVIEW_SCENARIOS = Object.freeze([
  "accept",
  "warning",
  "audited-row-marker-orphan-noop",
  "event-value-assignment",
  "same-operand-or-proof",
  "timed-initialization",
  "row-marker-proof",
  "native-select-empty-event",
  "fail-if-called",
  "provider-body-timeout"
]);
export const NEWOA_SCENARIOS = Object.freeze([
  "persist",
  "lose-layout-on-readback",
  "lose-required-on-readback",
  "fail-at-update"
]);

const SUCCESS_OPERATIONS = Object.freeze([
  "login",
  "init",
  "generate-table-name",
  "load-parent-category",
  "add",
  "get-before-update",
  "update",
  "get-readback",
  "add-transfer-record"
]);

const NATIVE_FORMULA_SUCCESS_OPERATIONS = Object.freeze([
  SUCCESS_OPERATIONS[0],
  "get-xform-desktop-digest",
  "get-xform-desktop-module-sha256",
  "get-xform-desktop-module-sha256",
  ...SUCCESS_OPERATIONS.slice(1)
]);

const WORKFLOW_SUCCESS_OPERATIONS = Object.freeze([
  SUCCESS_OPERATIONS[0],
  "get-element-info",
  ...SUCCESS_OPERATIONS.slice(1, -2),
  "save-workflow-draft",
  "get-workflow-detail",
  "get-readback",
  "add-transfer-record"
]);

const PARTICIPANT_OVERRIDE_WORKFLOW_SUCCESS_OPERATIONS = Object.freeze([
  SUCCESS_OPERATIONS[0],
  "get-element-info",
  "search-org",
  ...SUCCESS_OPERATIONS.slice(1, -2),
  "save-workflow-draft",
  "get-workflow-detail",
  "get-readback",
  "add-transfer-record"
]);

const GENERIC_ROLE_WORKFLOW_SUCCESS_OPERATIONS = Object.freeze([
  SUCCESS_OPERATIONS[0],
  "get-element-info",
  "search-org",
  ...SUCCESS_OPERATIONS.slice(1, -2),
  "save-workflow-draft",
  "get-workflow-detail",
  "get-readback",
  "add-transfer-record"
]);

const DRAFT_WORKFLOW_SUCCESS_OPERATIONS = Object.freeze([
  SUCCESS_OPERATIONS[0],
  ...SUCCESS_OPERATIONS.slice(1, -2),
  "save-workflow-draft",
  "get-workflow-detail",
  "get-readback",
  "add-transfer-record"
]);

const STATIC_ADDRESS_DEFAULT_SUCCESS_OPERATIONS = Object.freeze([
  SUCCESS_OPERATIONS[0],
  "get-element-info",
  ...SUCCESS_OPERATIONS.slice(1)
]);

const CONDITIONAL_WORKFLOW_SUCCESS_OPERATIONS = Object.freeze([
  "login",
  "get-xform-desktop-digest",
  "get-xform-desktop-module-sha256",
  "get-xform-desktop-module-sha256",
  "get-element-info",
  "search-org",
  "search-org",
  "get-element-info",
  ...SUCCESS_OPERATIONS.slice(1, -2),
  "save-workflow-draft",
  "get-workflow-detail",
  "get-readback",
  "add-transfer-record"
]);

const CONDITIONAL_PARALLEL_SUCCESS_OPERATIONS = Object.freeze([
  "login",
  "get-element-info",
  "get-element-info",
  "get-element-info",
  ...SUCCESS_OPERATIONS.slice(1, -2),
  "save-workflow-draft",
  "get-workflow-detail",
  "get-readback",
  "add-transfer-record"
]);

export const ROUTE_CASE_MANIFEST = deepFreeze({
  version: 1,
  cases: [
    {
      id: "choice-other-independent-main-success",
      source: { kind: "form-only", relativePath: "choice-other-companion-fidelity/main-checkbox_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "choice-other-independent-radio-success",
      source: { kind: "form-only", relativePath: "choice-other-companion-fidelity/main-radio_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "detail-row-property-blocked-before-transport",
      source: { kind: "form-only", relativePath: "detail-row-property-completeness/row-property_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { terminalStage: "review", reviewStatus: "blocked", reviewStage: "agent-review.incomplete", operations: [] }
    },
    {
      id: "main-row-property-blocked-before-transport",
      source: { kind: "form-only", relativePath: "detail-row-property-completeness/main-row-property_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { terminalStage: "review", reviewStatus: "blocked", reviewStage: "agent-review.incomplete", operations: [] }
    },
    {
      id: "source-sign-explicit-policy-success",
      source: { kind: "paired", relativePath: "workflow-sign" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      executionOptions: SIGN_OPTIONS,
      workflowOperationSets: [SIGN_OPERATIONS],
      organizationCandidates: [{ fdId: "post-a", fdName: "Post-A", fdOrgType: 4 }],
      expected: {
        reviewStatus: "needs_manual", dryRunStatus: "needs_manual", executionStatus: "written_with_warnings",
        operations: ["login", "get-workflow-cooperation-config", "get-workflow-operation-set", ...Array(5).fill("get-element-info"),
          ...SUCCESS_OPERATIONS.slice(1, -2), "save-workflow-draft", "get-workflow-detail", "get-readback", "get-workflow-operation-set", "add-transfer-record"]
      }
    },
    {
      id: "provider-body-timeout-blocks-review",
      source: { kind: "form-only", relativePath: "provider-body-timeout/provider_SysFormTemplate.xml" },
      reviewScenario: "provider-body-timeout",
      newoaScenario: "persist",
      confirmWrite: false,
      expected: {
        terminalStage: "review",
        reviewStatus: "blocked",
        reviewStage: "agent-review.network",
        operations: []
      }
    },
    {
      id: "input-native-length-success",
      source: { kind: "form-only", relativePath: "input-native-length/input-length_SysFormTemplate.xml" },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "sql-selector-readonly-projection-without-write",
      source: { kind: "form-only", relativePath: "sql-selector-readonly/sql-readonly_SysFormTemplate.xml" },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: false,
      expected: {
        terminalStage: "review",
        reviewStatus: "blocked",
        reviewStage: "agent-review.patch-validation",
        operations: []
      }
    },
    {
      id: "unbound-rest-selector-blocks-before-write",
      source: { kind: "form-only", relativePath: "remote-dialog-integrity/rest-string-true_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { terminalStage: "review", reviewStatus: "blocked", reviewStage: "agent-review.patch-validation", operations: [] }
    },
    {
      id: "generated-sql-lookup-blocks-before-write",
      source: { kind: "form-only", relativePath: "remote-dialog-integrity/sql-generated_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { terminalStage: "review", reviewStatus: "blocked", reviewStage: "agent-review.patch-validation", operations: [] }
    },
    {
      id: "jquery-ready-initialization-remains-gated",
      source: { kind: "form-only", relativePath: "jquery-ready-initialization/ready-initialization_SysFormTemplate.xml" },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: false,
      expected: {
        terminalStage: "review",
        reviewStatus: "blocked",
        reviewStage: "agent-review.incomplete",
        operations: []
      }
    },
    {
      id: "detail-column-consistency-success",
      source: { kind: "form-only", relativePath: "detail-column-consistency/detail-consistency_SysFormTemplate.xml" },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: { reviewStatus: "needs_manual", dryRunStatus: "needs_manual", executionStatus: "written_with_warnings", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "singleton-select-width-success",
      source: { kind: "form-only", relativePath: "native-field-width/single-selector_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "runtime-independent-caption-width-success",
      source: { kind: "form-only", relativePath: "native-field-width/amount-caption_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "leading-inline-caption-success",
      source: { kind: "form-only", relativePath: "leading-inline-caption/shared-leading_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "designer-checkbox-width-success",
      source: { kind: "form-only", relativePath: "designer-checkbox-width/checkbox-width_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "designer-select-face-width-success",
      source: { kind: "form-only", relativePath: "designer-select-face-width/select-face_SysFormTemplate.xml" },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "mobile-number-empty-placeholder-success",
      source: { kind: "form-only", relativePath: "mobile-number-empty-placeholder/mobile-number-empty-placeholder_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "radio-static-multiline-label-success",
      source: { kind: "form-only", relativePath: "radio-source-presentation/literal-qualification/multiline-label_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "radio-source-literal-unproven-blocks-review",
      source: { kind: "form-only", relativePath: "radio-source-presentation/literal-qualification/comment-phantom-H_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { terminalStage: "review", reviewStatus: "blocked", reviewStage: "agent-review.patch-validation", operations: [] }
    },
    {
      id: "radio-source-presentation-raw-success",
      source: { kind: "form-only", relativePath: "radio-source-presentation/raw-exporter_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "radio-source-presentation-success",
      source: { kind: "form-only", relativePath: "radio-source-presentation/radio-source-presentation_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "numeric-editor-width-success",
      source: { kind: "form-only", relativePath: "numeric-editor-width/numeric-editor-width_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "readonly-number-display-width-success",
      source: { kind: "form-only", relativePath: "readonly-number-display-width/readonly-number-width_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "mobile-number-layout-success",
      source: { kind: "form-only", relativePath: "mobile-number-layout/mobile-number-layout_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "mobile-plain-caption-success",
      source: { kind: "form-only", relativePath: "mobile-plain-caption/mobile-plain-caption_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "mobile-mixed-caption-success",
      source: { kind: "form-only", relativePath: "mobile-mixed-caption/mobile-mixed-caption_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "typed-hidden-caption-success",
      source: { kind: "form-only", relativePath: "typed-hidden-caption/typed-hidden-caption_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "mobile-caption-last-body-success",
      source: { kind: "form-only", relativePath: "mobile-caption-last-body/mobile-caption-last-body_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "mobile-caption-trailing-empty-success",
      source: { kind: "form-only", relativePath: "mobile-caption-trailing-empty/trailing-empty_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "mobile-caption-trailing-empty-event-success",
      source: { kind: "form-only", relativePath: "mobile-caption-trailing-empty/local-event_SysFormTemplate.xml" },
      reviewScenario: "native-select-empty-event", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "mobile-caption-trailing-empty-editor-event-success",
      source: { kind: "form-only", relativePath: "mobile-caption-trailing-empty/editor-local-event_SysFormTemplate.xml" },
      reviewScenario: "native-select-empty-event", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "mobile-caption-trailing-break-success",
      source: { kind: "form-only", relativePath: "mobile-caption-trailing-break/caption-trailing-break_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "native-formula-condition-scope-success",
      source: { kind: "form-only", relativePath: "native-formula-condition-scope/native-formula-condition-scope_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: NATIVE_FORMULA_SUCCESS_OPERATIONS }
    },
    {
      id: "inline-editor-width-success",
      source: { kind: "form-only", relativePath: "inline-editor-width/inline-editor-width_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "static-jsp-caption-evidence-success",
      source: { kind: "form-only", relativePath: "static-jsp-caption-evidence/static-jsp-caption_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "designer-caption-width-success",
      source: { kind: "form-only", relativePath: "designer-caption-width/designer-caption-width_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "checkbox-source-direction-success",
      source: { kind: "form-only", relativePath: "checkbox-source-direction/checkbox-direction_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "native-select-empty-event-success",
      source: { kind: "form-only", relativePath: "native-select-empty-event/select-empty_SysFormTemplate.xml" },
      reviewScenario: "native-select-empty-event", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "row-marker-timed-select-proof-success",
      source: { kind: "form-only", relativePath: "row-marker-proof/timed-getter_SysFormTemplate.xml" },
      reviewScenario: "row-marker-proof", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "row-marker-atomic-proof-success",
      source: { kind: "form-only", relativePath: "row-marker-proof/synchronous-existing-getter-contract_SysFormTemplate.xml" },
      reviewScenario: "row-marker-proof", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "timed-initialization-retains-schedule",
      source: {
        kind: "form-only",
        relativePath: "timed-initialization/timed-initialization_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: false,
      expected: {
        terminalStage: "review",
        reviewStatus: "blocked",
        reviewStage: "agent-review.incomplete",
        operations: []
      }
    },
    {
      id: "timed-initialization-success",
      source: {
        kind: "form-only",
        relativePath: "timed-initialization/timed-initialization_SysFormTemplate.xml"
      },
      reviewScenario: "timed-initialization",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "same-operand-or-proof-success",
      source: {
        kind: "form-only",
        relativePath: "same-operand-or-proof/same-operand-or-proof_SysFormTemplate.xml"
      },
      reviewScenario: "same-operand-or-proof",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "timer-helper-context-remains-gated",
      source: {
        kind: "form-only",
        relativePath: "timer-helper-context/timer-helper_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: false,
      expected: {
        terminalStage: "review",
        reviewStatus: "blocked",
        reviewStage: "agent-review.incomplete",
        operations: []
      }
    },
    {
      id: "dynamic-hyperlink-target-success",
      source: {
        kind: "form-only",
        relativePath: "dynamic-hyperlink-target/route-hyperlink-target_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "form-only-success",
      source: {
        kind: "form-only",
        relativePath: "form-only/route-form-only_SysFormTemplate.xml",
        templateName: "原流程模板"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "placeholder-static-success",
      source: {
        kind: "form-only",
        relativePath: "placeholder-static/route-placeholder-static_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "attachment-native-required-success",
      source: {
        kind: "form-only",
        relativePath: "attachment-native-required/route-attachment-native-required_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "attachment-without-identity-else-success",
      source: { kind: "form-only", relativePath: "attachment-identity-else/route-direct-without-else_SysFormTemplate.xml" },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: { reviewStatus: "needs_manual", dryRunStatus: "needs_manual", executionStatus: "written_with_warnings", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "compact-procurement-layout-success",
      source: {
        kind: "form-only",
        relativePath: "compact-procurement-layout/route-compact-procurement-layout_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "link-label-description-success",
      source: {
        kind: "form-only",
        relativePath: "link-label-description/route-link-label-description_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "hidden-detail-data-column-success",
      source: {
        kind: "form-only",
        relativePath: "hidden-detail-data-column/route-hidden-detail-data-column_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "choice-other-mixed-unproven-blocked-before-transport",
      source: {
        kind: "form-only",
        relativePath: "choice-other-option/route-choice-other-option_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        terminalStage: "review",
        reviewStatus: "blocked",
        reviewStage: "agent-review.input",
        operations: []
      }
    },
    {
      id: "checkbox-other-option-detail-blocked-before-transport",
      source: {
        kind: "form-only",
        relativePath: "checkbox-other-option/route-checkbox-other-option_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        terminalStage: "review",
        reviewStatus: "blocked",
        reviewStage: "agent-review.input",
        operations: []
      }
    },
    {
      id: "person-company-ajax-hydration-success",
      source: {
        kind: "form-only",
        relativePath: "person-company-ajax-hydration/route-person-company-ajax-hydration_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "option-normalization-success",
      source: {
        kind: "form-only",
        relativePath: "option-normalization/route-option-normalization_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "semantic-props-success",
      source: {
        kind: "paired",
        relativePath: "semantic-props"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: DRAFT_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "static-address-default-success",
      source: {
        kind: "form-only",
        relativePath: "static-address-default/route-static-address-default_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: STATIC_ADDRESS_DEFAULT_SUCCESS_OPERATIONS
      }
    },
    {
      id: "calculation-migration-success",
      source: {
        kind: "form-only",
        relativePath: "calculation-migration/route-calculation-migration_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "calculation-script-recipes-success",
      source: {
        kind: "form-only",
        relativePath: "calculation-script-recipes/route-calculation-script-recipes_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "finance-detail-generation-success",
      source: {
        kind: "form-only",
        relativePath: "finance-detail-generation/route-finance-detail-generation_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "travel-reimbursement-lifecycle-success",
      source: {
        kind: "form-only",
        relativePath: "travel-reimbursement-lifecycle/route-travel-reimbursement-lifecycle_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: NATIVE_FORMULA_SUCCESS_OPERATIONS
      }
    },
    {
      id: "detail-cascade-actions-success",
      source: {
        kind: "form-only",
        relativePath: "detail-cascade-actions/route-detail-cascade-actions_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "permission-caption-row-success",
      source: { kind: "form-only", relativePath: "permission-caption-row/route-permission-caption-row_SysFormTemplate.xml" },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written", operations: SUCCESS_OPERATIONS }
    },
    {
      id: "nested-spanned-header-grid-success",
      source: {
        kind: "form-only",
        relativePath: "nested-spanned-header-grid/route-nested-spanned-header-grid_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "row-marker-grid-mixed-nested-success",
      source: {
        kind: "form-only",
        relativePath: "row-marker-grid/mixed-nested_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "row-marker-grid-alias-lifecycle-success",
      source: {
        kind: "form-only",
        relativePath: "row-marker-grid/alias-lifecycle_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "row-marker-grid-alias-nested-load-success",
      source: {
        kind: "form-only",
        relativePath: "row-marker-grid/alias-nested-load_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "event-value-assignment-prefix-success",
      source: {
        kind: "form-only",
        relativePath: "event-value-assignment/event-prefix_SysFormTemplate.xml"
      },
      reviewScenario: "event-value-assignment",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "event-value-assignment-else-success",
      source: {
        kind: "form-only",
        relativePath: "event-value-assignment/event-else_SysFormTemplate.xml"
      },
      reviewScenario: "event-value-assignment",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "script-field-reference-comments-blocked",
      source: {
        kind: "form-only",
        relativePath: "script-field-reference-comments/route-comment-fields_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: false,
      expected: {
        terminalStage: "review",
        reviewStatus: "blocked",
        reviewStage: "agent-review.incomplete",
        operations: []
      }
    },
    {
      id: "review-helper-context-remains-gated",
      source: {
        kind: "form-only",
        relativePath: "review-helper-context/shared-helper_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: false,
      expected: {
        terminalStage: "review",
        reviewStatus: "blocked",
        reviewStage: "agent-review.incomplete",
        operations: []
      }
    },
    {
      id: "main-field-value-row-lifecycle-success",
      source: {
        kind: "form-only",
        relativePath: "main-field-value-row-lifecycle/route-main-field-value-row-lifecycle_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "detail-main-row-lifecycle-success",
      source: {
        kind: "form-only",
        relativePath: "detail-main-row-lifecycle/route-detail-main-row-lifecycle_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "multi-batch-review-success",
      source: {
        kind: "form-only",
        relativePath: "multi-batch/route-multi-batch_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "custom-base-url-success",
      source: {
        kind: "form-only",
        relativePath: "form-only/route-form-only_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      baseUrl: " http://LOCALHOST:8080/ ",
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "written",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "paired-success",
      source: {
        kind: "paired",
        relativePath: "paired"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "department-leader-alias-success",
      source: {
        kind: "paired",
        relativePath: "department-leader-alias"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: DRAFT_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "participant-explicit-override-success",
      source: {
        kind: "paired",
        relativePath: "companion-person-source"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      participantOverrides: [{
        sourceId: "legacy-companion-reviewer",
        targetFdId: "route-explicit-person-override"
      }],
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: PARTICIPANT_OVERRIDE_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "generic-role-participant-success",
      source: {
        kind: "paired",
        relativePath: "generic-role-participant"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: GENERIC_ROLE_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "workflow-data-authority-success",
      source: {
        kind: "paired",
        relativePath: "workflow-data-authority"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: DRAFT_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "workflow-completion-notifications-success",
      source: {
        kind: "paired",
        relativePath: "workflow-completion-notifications"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: DRAFT_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "conditional-parallel-success",
      source: {
        kind: "paired",
        relativePath: "conditional-parallel"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: CONDITIONAL_PARALLEL_SUCCESS_OPERATIONS
      }
    },
    {
      id: "manual-branch-success",
      source: {
        kind: "paired",
        relativePath: "manual-branch"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: DRAFT_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "shanghai-electric-dev-fallback-success",
      source: {
        kind: "paired",
        relativePath: "conditional-detail"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      baseUrl: "http://oa-dev.shanghai-electric.com:8088",
      fallbackFdIds: {
        person: "route-configured-person-fallback",
        organization: "route-configured-organization-fallback"
      },
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: CONDITIONAL_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "shanghai-electric-oaqas-https-fallback-success",
      source: {
        kind: "paired",
        relativePath: "conditional-detail"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      baseUrl: "https://oaqas.shanghai-electric.com",
      fallbackFdIds: {
        person: "route-configured-person-fallback",
        organization: "route-configured-organization-fallback"
      },
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: CONDITIONAL_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "kmreview-named-success",
      source: {
        kind: "paired",
        relativePath: "kmreview-named"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "warning-but-executable",
      source: {
        kind: "form-only",
        relativePath: "form-only/route-form-only_SysFormTemplate.xml"
      },
      reviewScenario: "warning",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "row-marker-orphan-noop-success",
      source: {
        kind: "form-only",
        relativePath: "row-marker-orphan/route-row-marker-orphan_SysFormTemplate.xml"
      },
      reviewScenario: "audited-row-marker-orphan-noop",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: SUCCESS_OPERATIONS
      }
    },
    {
      id: "conditional-detail-success",
      source: {
        kind: "paired",
        relativePath: "conditional-detail"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: CONDITIONAL_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "blocked-before-transport",
      source: {
        kind: "form-only",
        relativePath: "form-only/route-form-only_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: false,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "blocked",
        operations: []
      }
    },
    {
      id: "unmapped-formula-blocked-before-transport",
      source: {
        kind: "paired",
        relativePath: "unmapped-formula"
      },
      reviewScenario: "fail-if-called",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        terminalStage: "review",
        reviewStatus: "blocked",
        reviewStage: "agent-review.input",
        operations: []
      }
    },
    {
      id: "node-history-handlers-success",
      source: {
        kind: "paired",
        relativePath: "node-history-handlers"
      },
      reviewScenario: "accept",
      newoaScenario: "persist",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "written_with_warnings",
        operations: DRAFT_WORKFLOW_SUCCESS_OPERATIONS
      }
    },
    {
      id: "readback-loss",
      source: {
        kind: "paired",
        relativePath: "paired"
      },
      reviewScenario: "accept",
      newoaScenario: "lose-layout-on-readback",
      confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual",
        dryRunStatus: "needs_manual",
        executionStatus: "readback_failed",
        executionStage: "readback",
        operations: WORKFLOW_SUCCESS_OPERATIONS.slice(0, -1)
      }
    },
    {
      id: "required-readback-loss",
      source: {
        kind: "form-only",
        relativePath: "form-only/route-form-only_SysFormTemplate.xml"
      },
      reviewScenario: "accept",
      newoaScenario: "lose-required-on-readback",
      confirmWrite: true,
      expected: {
        reviewStatus: "passed",
        dryRunStatus: "passed",
        executionStatus: "readback_failed",
        executionStage: "readback",
        operations: SUCCESS_OPERATIONS.slice(0, -1)
      }
    }
  ]
});

export function validateRouteManifest(manifest) {
  assertPureData(manifest, "manifest");
  if (manifest?.version !== 1 || !Array.isArray(manifest?.cases) || manifest.cases.length === 0) {
    throw integrityError("route.manifest.invalid", "Route manifest must have version 1 and at least one case.");
  }

  const seen = new Set();
  for (const routeCase of manifest.cases) {
    if (!isPlainRecord(routeCase) || !nonEmptyString(routeCase.id) || seen.has(routeCase.id)) {
      throw integrityError("route.manifest.invalid", "Route case ids must be unique non-empty strings.");
    }
    seen.add(routeCase.id);
    if (!isPlainRecord(routeCase.source) || !["form-only", "paired"].includes(routeCase.source.kind)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has an invalid source kind.`);
    }
    if (!safeRelativePath(routeCase.source.relativePath)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has an unsafe fixture path.`);
    }
    if (routeCase.source.templateName !== undefined && !nonEmptyString(routeCase.source.templateName)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has an invalid source template name.`);
    }
    if (!REVIEW_SCENARIOS.includes(routeCase.reviewScenario)) {
      throw integrityError("route.scenario.review_unknown", `Unknown review scenario: ${routeCase.reviewScenario}`);
    }
    if (!NEWOA_SCENARIOS.includes(routeCase.newoaScenario)) {
      throw integrityError("route.scenario.newoa_unknown", `Unknown NewOA scenario: ${routeCase.newoaScenario}`);
    }
    if (typeof routeCase.confirmWrite !== "boolean" || !isPlainRecord(routeCase.expected)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has invalid execution data.`);
    }
    if (routeCase.baseUrl !== undefined && !nonEmptyString(routeCase.baseUrl)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has an invalid base URL.`);
    }
    if (routeCase.fallbackFdIds !== undefined && !validFallbackFdIds(routeCase.fallbackFdIds)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has invalid fallback fdIds.`);
    }
    if (routeCase.participantOverrides !== undefined &&
        !validParticipantOverrides(routeCase.participantOverrides)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has invalid participant overrides.`);
    }
    if (routeCase.executionOptions !== undefined) executionOptions(routeCase.executionOptions);
    const expected = routeCase.expected;
    const reviewTerminal = expected.terminalStage === "review";
    if (!nonEmptyString(expected.reviewStatus) ||
        !Array.isArray(expected.operations) ||
        expected.operations.some((operation) => !nonEmptyString(operation)) ||
        (reviewTerminal && (!nonEmptyString(expected.reviewStage) || expected.operations.length !== 0)) ||
        (!reviewTerminal && (!nonEmptyString(expected.dryRunStatus) || !nonEmptyString(expected.executionStatus))) ||
        (expected.terminalStage !== undefined && !reviewTerminal)) {
      throw integrityError("route.manifest.invalid", `Route case ${routeCase.id} has invalid expected data.`);
    }
  }
  return manifest;
}

export function findRouteCase(caseId, manifest = ROUTE_CASE_MANIFEST) {
  validateRouteManifest(manifest);
  const routeCase = manifest.cases.find((candidate) => candidate.id === caseId);
  if (!routeCase) {
    throw integrityError("route.case.unknown", `Unknown Route case: ${caseId}`);
  }
  return routeCase;
}

function assertPureData(value, path) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPureData(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainRecord(value)) {
    throw integrityError("route.manifest.not_data", `Route manifest contains non-data at ${path}.`);
  }
  for (const [key, entry] of Object.entries(value)) {
    assertPureData(entry, `${path}.${key}`);
  }
}

function safeRelativePath(value) {
  return nonEmptyString(value) && !value.startsWith("/") && !value.split(/[\\/]+/).includes("..");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function isPlainRecord(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validFallbackFdIds(value) {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set(["person", "organization", "group", "post"]);
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([kind, fdId]) => allowed.has(kind) && nonEmptyString(fdId));
}

function validParticipantOverrides(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  const sourceIds = new Set();
  return value.every((override) => {
    if (!isPlainRecord(override) ||
        !nonEmptyString(override.sourceId) ||
        !nonEmptyString(override.targetFdId) ||
        Object.keys(override).some((key) => !["sourceId", "targetFdId"].includes(key)) ||
        sourceIds.has(override.sourceId)) {
      return false;
    }
    sourceIds.add(override.sourceId);
    return true;
  });
}
