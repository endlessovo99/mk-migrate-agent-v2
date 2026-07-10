import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleForm, sampleTrustedDsl, sampleWorkflow } from "../helpers/sample-dsl.js";
import {
  formAttr,
  persistAndVerify,
  prepareSample,
  sampleBaseTemplate,
  sampleEnvelope,
  xformConfig
} from "../helpers/persistence.js";
import { preparePersistedTemplate } from "../../src/executor/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");

describe("preparePersistedTemplate interface", () => {
  it("verifies a healthy projected template", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl());
    assert.equal(readback.ok, true);
    assert.equal(readback.status, "verified");
    assert.equal(readback.invariantVersion, 1);
    assert.deepEqual(readback.partitions, {
      envelope: "verified",
      form: "verified",
      rules: "verified",
      scripts: "verified",
      workflow: "verified"
    });
  });

  it("reports workflow as not_expected for form-only DSL", () => {
    const dsl = sampleTrustedDsl({ workflow: null });
    delete dsl.workflow;
    const { readback } = persistAndVerify(dsl);
    assert.equal(readback.ok, true);
    assert.equal(readback.partitions.workflow, "not_expected");
    assert.equal(readback.workflow, undefined);
  });
});

describe("envelope mutations", () => {
  for (const [name, mutate] of [
    ["wrong fdId", (template) => {
      template.fdId = "other-id";
      return template;
    }],
    ["missing name", (template) => {
      template.fdName = "";
      return template;
    }],
    ["wrong category", (template) => {
      template.fdCategory = { fdId: "wrong-category" };
      return template;
    }],
    ["wrong table name", (template) => {
      template.mechanisms["sys-xform"].fdTableName = "wrong_table";
      return template;
    }],
    ["wrong lifecycle", (template) => {
      template.fdStatus = 1;
      return template;
    }]
  ]) {
    it(`fails on ${name}`, () => {
      const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), { mutate });
      assert.equal(readback.ok, false);
      assert.equal(readback.partitions.envelope, "mismatch");
    });
  }
});

describe("form field and detail mutations", () => {
  it("fails when a field title changes", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        const field = config.dataModel[0].fdFields.find((item) => item.fdName === "fd_subject");
        field.fdLabel = "被篡改";
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.form.field_title"), true);
  });

  it("fails when data-only visibility is lost", () => {
    const form = sampleForm();
    form.fields.push({
      id: "fd_hidden",
      title: "隐藏",
      type: "text",
      componentId: "xform-input",
      props: {},
      dataOnly: true,
      sourceRef: "source.form.dataField.fd_hidden"
    });
    const { readback } = persistAndVerify(sampleTrustedDsl({ form, workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        const field = config.dataModel[0].fdFields.find((item) => item.fdName === "fd_hidden");
        field.fdDisplay = true;
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.form.data_only_flag_mismatch"), true);
  });

  it("fails when a detail column is missing or unexpected", () => {
    const missing = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        const detail = config.dataModel.find((model) => model.fdType === "detail");
        detail.fdFields = detail.fdFields.filter((field) => field.fdIsSystem);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(missing.readback.ok, false);
    assert.equal(missing.readback.diagnostics.some((item) => item.code === "readback.form.detail_column_missing"), true);

    const unexpected = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        const detail = config.dataModel.find((model) => model.fdType === "detail");
        const clone = JSON.parse(JSON.stringify(detail.fdFields.find((field) => !field.fdIsSystem)));
        clone.fdName = "fd_extra";
        clone.fdLabel = "额外";
        detail.fdFields.unshift(clone);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(unexpected.readback.ok, false);
    assert.equal(unexpected.readback.diagnostics.some((item) => item.code === "readback.form.unexpected_detail_column"), true);
  });

  it("fails when native layout placement changes while migration markers stay correct", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        const view = JSON.parse(config.viewModel[0].fdConfig);
        const main = view.view.render.desktop[0].children[0];
        const row = main.children[0];
        const grid = row.children[0];
        const first = grid.children[0];
        const second = grid.children[1];
        // Keep migration markers, swap native child keys (placement).
        const firstRef = first.children[0];
        const secondRef = second.children[0];
        const firstKey = firstRef.key;
        firstRef.key = secondRef.key;
        secondRef.key = firstKey;
        config.viewModel[0].fdConfig = JSON.stringify(view);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.form.layout_cell_fields_mismatch"), true);
  });
});

describe("marker independence", () => {
  it("passes when native semantics are intact but migration markers are corrupt", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        delete config.migrationDsl;
        const attr = JSON.parse(config.attribute.formAttr);
        delete attr.migrationDsl;
        const view = JSON.parse(config.viewModel[0].fdConfig);
        const main = view.view.render.desktop[0].children[0];
        for (const row of main.children) {
          if (row.controlProps) {
            delete row.controlProps.migrationRowId;
            delete row.controlProps.migrationLayoutComponentId;
          }
          const grid = row.children?.[0];
          for (const item of grid?.children || []) {
            if (item.controlProps) {
              delete item.controlProps.migrationFieldIds;
              delete item.controlProps.migrationFieldId;
              delete item.controlProps.migrationRowId;
              delete item.controlProps.migrationColumn;
              delete item.controlProps.migrationColspan;
            }
            if (item.children?.[0]) {
              delete item.children[0].migrationFieldIds;
              delete item.children[0].migrationFieldId;
            }
          }
        }
        config.viewModel[0].fdConfig = JSON.stringify(view);
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, true);
  });

  it("fails when markers are correct but a native field component is wrong", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        const field = config.dataModel[0].fdFields.find((item) => item.fdName === "fd_subject");
        const attribute = JSON.parse(field.fdAttribute);
        attribute.config.controlProps.desktop = { type: "@elem/xform-textarea" };
        attribute.config.type = "@elem/xform-textarea";
        field.fdAttribute = JSON.stringify(attribute);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.form.component_mismatch"), true);
  });
});

describe("form rules mutations", () => {
  function dslWithRules() {
    const form = sampleForm();
    form.layout.mkTree[1] = {
      ...form.layout.mkTree[1],
      sourceMarkers: ["fd_detail_row"]
    };
    return sampleTrustedDsl({
      form,
      workflow: null,
      formRules: {
        linkage: [{
          id: "linkage.subject.detail",
          trigger: "change",
          source: "fd_subject",
          logic: "and",
          when: [{ field: "fd_subject", op: "contains", value: "A" }],
          effects: [
            { type: "visible", target: "fd_detail_row", value: true },
            { type: "required", target: "fd_detail_row", value: true }
          ],
          else: [
            { type: "visible", target: "fd_detail_row", value: false },
            { type: "required", target: "fd_detail_row", value: false }
          ],
          translationStatus: "executable"
        }],
        validations: [],
        impliedRequired: [],
        review: {}
      }
    });
  }

  it("fails when rule counts match but conditions are wrong", () => {
    const { readback } = persistAndVerify(dslWithRules(), {
      mutate(template) {
        const attr = formAttr(template);
        attr.formRule.display[0].choices.items[0].operate = "!=";
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify({
          ...xformConfig(template),
          attribute: {
            ...xformConfig(template).attribute,
            formAttr: JSON.stringify(attr)
          }
        });
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.form_rules.semantic_missing"), true);
  });

  it("passes when unrelated manual rules coexist", () => {
    const { readback } = persistAndVerify(dslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.formRule.display.push({
          id: "manual-rule",
          ruleName: "manual",
          active: true,
          condition: "1",
          choices: { items: [] },
          result: []
        });
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, true);
  });

  it("passes when a semantically equivalent rule lacks provenance markers", () => {
    const { readback } = persistAndVerify(dslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        for (const rule of [...attr.formRule.display, ...attr.formRule.require]) {
          delete rule.meta;
          rule.ruleName = "manual-equivalent";
        }
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, true);
  });
});

describe("script mutations", () => {
  function dslWithScripts() {
    return sampleTrustedDsl({
      workflow: null,
      scripts: {
        actions: [{
          id: "load-edit",
          name: "onLoad",
          event: "onLoad",
          scope: "global",
          function: "function onLoad() { MKXFORM.setValue('fd_subject', 'x') }",
          translationStatus: "mapped",
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          functionMappings: [],
          runWhen: { viewStatusIn: ["add", "edit"] }
        }, {
          id: "omit-me",
          name: "onLoad",
          event: "onLoad",
          scope: "global",
          function: "function onLoad() { return true }",
          translationStatus: "omitted",
          coverage: { status: "native-covered", nativeRules: ["required"], residuals: [] },
          functionMappings: []
        }]
      }
    });
  }

  it("fails when the canonical view-status guard is removed", () => {
    const { readback } = persistAndVerify(dslWithScripts(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        const action = attr.controlAction.global.onLoad[0];
        action.function = action.function
          .replace(/\/\*\s*mk-migrate:view-status=[^*]+?\*\//g, "")
          .replace(/if \(MKXFORM\.viewStatus !== "add" && MKXFORM\.viewStatus !== "edit"\) return;?\s*/g, "");
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.scripts.run_when_mismatch"), true);
  });

  it("fails when an omitted action is unexpectedly present as a top-level id", () => {
    const { readback } = persistAndVerify(dslWithScripts(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.controlAction.global.onChange = [{
          id: "omit-me",
          name: "onChange",
          function: "function onChange() { return true }"
        }];
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) =>
      item.code === "readback.scripts.omitted_action_present" ||
      item.code === "readback.scripts.unexpected_action"
    ), true);
  });
});

describe("workflow mutations", () => {
  it("fails on unexpected nodes and edges", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl(), {
      mutate(template) {
        const lbpm = template.mechanisms.lbpmTemplate[0];
        const content = JSON.parse(lbpm.fdContent);
        content.elements.push({ id: "N999", type: "review", element: "manualTask", name: "额外" });
        content.elements.push({ id: "L999", type: "sequenceFlow", sourceRef: "N1", targetRef: "N999" });
        lbpm.fdContent = JSON.stringify(content);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.workflow.unexpected_node"), true);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.workflow.unexpected_edge"), true);
  });

  it("fails on edge endpoint mutation", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl(), {
      mutate(template) {
        const lbpm = template.mechanisms.lbpmTemplate[0];
        const content = JSON.parse(lbpm.fdContent);
        const edge = content.elements.find((element) => element.type === "sequenceFlow");
        edge.targetRef = "missing";
        lbpm.fdContent = JSON.stringify(content);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.workflow.edge_endpoint_mismatch"), true);
  });

  it("tolerates coordinate and waypoint presentation differences", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl(), {
      mutate(template) {
        const lbpm = template.mechanisms.lbpmTemplate[0];
        const content = JSON.parse(lbpm.fdContent);
        for (const element of content.elements) {
          element.x = (element.x || 0) + 50;
          element.y = (element.y || 0) + 50;
          if (element.type === "sequenceFlow") {
            element.waypoints = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
          }
        }
        lbpm.fdContent = JSON.stringify(content);
        return template;
      }
    });
    assert.equal(readback.ok, true);
  });

  it("rejects unknown workflow node types at projection time", () => {
    const workflow = sampleWorkflow();
    workflow.nodes[0] = {
      ...workflow.nodes[0],
      type: "legacyManualTask"
    };
    const prepared = preparePersistedTemplate({
      dsl: sampleTrustedDsl({ workflow }),
      envelope: sampleEnvelope(),
      baseTemplate: sampleBaseTemplate()
    });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.diagnostics.some((item) => item.code === "projection.workflow.node_type_unsupported"), true);
  });
});

describe("decode failures", () => {
  it("reports one precise fdConfig decode diagnostic without cascaded count noise", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        template.mechanisms["sys-xform"].fdConfig = "{not-json";
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.partitions.form, "decode_failed");
    const decodeDiagnostics = readback.diagnostics.filter((item) => item.code.startsWith("readback.decode."));
    assert.equal(decodeDiagnostics.length, 1);
    assert.equal(decodeDiagnostics[0].code, "readback.decode.fdConfig.invalid_json");
    assert.equal(readback.diagnostics.every((item) => !String(item.code).includes("field_count")), true);
  });

  it("reports malformed formAttr without cascading script count mismatches", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        config.attribute.formAttr = "{bad";
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.partitions.rules, "decode_failed");
    assert.equal(readback.partitions.scripts, "decode_failed");
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.decode.formAttr.invalid_json"), true);
    assert.equal(readback.diagnostics.every((item) => !String(item.code).includes("action_count")), true);
  });

  it("loads an independently authored native fixture for successful readback", () => {
    const dsl = sampleTrustedDsl({ workflow: null });
    const prepared = prepareSample(dsl);
    const fixture = JSON.parse(readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8"));
    // Fixture is authored from a sanitized projection snapshot checked into the repo,
    // not cloned inside the test from the live writer output.
    const readback = prepared.verify(fixture);
    assert.equal(readback.ok, true);
  });
});
