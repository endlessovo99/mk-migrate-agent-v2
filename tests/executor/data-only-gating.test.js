import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sampleForm, sampleTrustedDsl } from "../helpers/sample-dsl.js";
import {
  formAttr,
  persistAndVerify,
  projectTemplate,
  summarizeProjectedForm,
  verifyTemplate,
  xformConfig
} from "../helpers/persistence.js";

function dataOnlyDsl() {
  const form = sampleForm();
  form.fields.push({
    id: "fd_shift",
    title: "脚本状态",
    type: "text",
    componentId: "xform-input",
    props: {},
    sourceProps: { metadataAttributes: { canDisplay: "false" } },
    sourceRef: "source.form.dataField.fd_shift",
    dataOnly: true
  });
  return sampleTrustedDsl({
    form,
    workflow: null,
    scripts: {
      actions: [
        mappedLoadAction("edit-load", { viewStatusIn: ["add", "edit"] }),
        mappedLoadAction("view-load", { viewStatusIn: ["view"] })
      ]
    }
  });
}

function mappedLoadAction(id, runWhen, functionText = "function onLoad() { MKXFORM.getValue('fd_shift') }") {
  return {
    id,
    name: "onLoad",
    event: "onLoad",
    scope: "global",
    function: functionText,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "GetXFormFieldById",
      target: "MKXFORM.getValue",
      basis: "semantic-translation",
      reviewRequired: false
    }],
    runWhen
  };
}

describe("executor data-only fields and view gates", () => {
  it("persists global onLoad actions as one ordered guard-isolated dispatcher", () => {
    const dsl = sampleTrustedDsl({
      workflow: null,
      scripts: {
        actions: [
          mappedLoadAction(
            "view-load",
            { viewStatusIn: ["view"] },
            "function onLoad() { MKXFORM.setValue('fd_subject', 'view') }"
          ),
          mappedLoadAction(
            "always-load",
            undefined,
            "function onLoad() { MKXFORM.getValue('${table:fd_detail}'); MKXFORM.setValue('fd_subject', 'always') }"
          ),
          mappedLoadAction(
            "edit-load",
            { viewStatusIn: ["add", "edit"] },
            "function onLoad() { MKXFORM.setValue('fd_subject', 'edit') }"
          )
        ]
      }
    });
    const template = projectTemplate(dsl);
    const config = xformConfig(template);
    const attr = JSON.parse(config.attribute.formAttr);
    const persisted = attr.controlAction.global.onLoad;
    const detailTableName = config.dataModel.find((model) =>
      model.fdType === "detail" && model.dynamicProps?.detailFieldName === "fd_detail"
    ).fdTableName;
    const scripts = summarizeProjectedForm(template).scripts;

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].name, "onLoad");
    assert.deepEqual(persisted[0].migrationActions, [
      { id: "view-load", name: "onLoad_1", migrationRunWhen: { viewStatusIn: ["view"] } },
      { id: "always-load", name: "onLoad_2" },
      { id: "edit-load", name: "onLoad_3", migrationRunWhen: { viewStatusIn: ["add", "edit"] } }
    ]);
    assert.equal(persisted[0].function.includes("${table:"), false);
    assert.equal(persisted[0].function.includes(`MKXFORM.getValue('${detailTableName}')`), true);
    assert.equal(scripts.actionCount, 3);
    assert.equal(verifyTemplate(dsl, template).ok, true);

    assert.deepEqual(runPersistedAction(persisted[0], "add"), [
      ["getValue", detailTableName],
      ["setValue", "fd_subject", "always"],
      ["setValue", "fd_subject", "edit"]
    ]);
    assert.deepEqual(runPersistedAction(persisted[0], "view"), [
      ["setValue", "fd_subject", "view"],
      ["getValue", detailTableName],
      ["setValue", "fd_subject", "always"]
    ]);
  });

  it("stores data-only fields without rendering and injects canonical view-status guards", () => {
    const dsl = dataOnlyDsl();
    const template = projectTemplate(dsl);
    const config = xformConfig(template);
    const mainModel = config.dataModel.find((model) => model.fdType === "main");
    const hidden = mainModel.fdFields.find((field) => field.fdName === "fd_shift");
    const viewConfig = JSON.parse(config.viewModel[0].fdConfig);
    const attr = JSON.parse(config.attribute.formAttr);
    const actions = attr.controlAction.global.onLoad;

    assert.equal(hidden.fdIsStored, true);
    assert.equal(hidden.fdDisplay, false);
    assert.equal(JSON.stringify(viewConfig).includes("fd_shift"), false);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].function.includes("/* mk-migrate:view-status=add,edit */"), true);
    assert.equal(actions[0].function.includes("MKXFORM.viewStatus !== \"add\""), true);
    assert.equal(actions[0].function.includes("MKXFORM.viewStatus !== \"edit\""), true);
    assert.equal(actions[0].function.includes("/* mk-migrate:view-status=view */"), true);
    assert.equal(actions[0].function.includes("MKXFORM.viewStatus !== \"view\""), true);
    assert.deepEqual(actions[0].migrationActions.map((action) => [action.id, action.name]), [
      ["edit-load", "onLoad_1"],
      ["view-load", "onLoad_2"]
    ]);
    assert.equal(verifyTemplate(dsl, template).ok, true);
  });

  for (const [scenario, functionText] of [
    [
      "inside an unreachable branch",
      `function onLoad() {
        if (false) {
          /* mk-migrate:view-status=add,edit */
          if (MKXFORM.viewStatus !== "add" && MKXFORM.viewStatus !== "edit") return;
        }
        MKXFORM.setValue("fd_subject", "leaked");
      }`
    ],
    [
      "after a side effect",
      `function onLoad() {
        MKXFORM.setValue("fd_subject", "leaked");
        /* mk-migrate:view-status=add,edit */
        if (MKXFORM.viewStatus !== "add" && MKXFORM.viewStatus !== "edit") return;
      }`
    ]
  ]) {
    it(`injects a real leading guard when matching guard text appears ${scenario}`, () => {
      const dsl = sampleTrustedDsl({
        workflow: null,
        scripts: {
          actions: [mappedLoadAction("edit-load", { viewStatusIn: ["add", "edit"] }, functionText)]
        }
      });
      const template = projectTemplate(dsl);
      const config = xformConfig(template);
      const attr = JSON.parse(config.attribute.formAttr);
      const persisted = attr.controlAction.global.onLoad[0];

      assert.deepEqual(runPersistedAction(persisted, "view"), []);
      assert.equal(verifyTemplate(dsl, template).ok, true);
    });
  }

  it("fails readback when a data-only field becomes displayable or enters layout", () => {
    const dsl = dataOnlyDsl();
    const displayable = persistAndVerify(dsl, {
      mutate(template) {
        const config = xformConfig(template);
        config.dataModel[0].fdFields.find((field) => field.fdName === "fd_shift").fdDisplay = true;
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    }).readback;

    const rendered = persistAndVerify(dsl, {
      mutate(template) {
        const config = xformConfig(template);
        const viewConfig = JSON.parse(config.viewModel[0].fdConfig);
        const main = viewConfig.view.render.desktop[0].children[0];
        const firstFieldRef = main.children[0].children[0].children[0].children[0];
        firstFieldRef.key = "fd_shift";
        config.viewModel[0].fdConfig = JSON.stringify(viewConfig);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    }).readback;

    assert.equal(displayable.ok, false);
    assert.equal(displayable.diagnostics.some((item) => item.code === "readback.form.data_only_flag_mismatch"), true);
    assert.equal(rendered.ok, false);
    assert.equal(rendered.diagnostics.some((item) =>
      item.code === "readback.form.data_only_field_rendered" ||
      item.code === "readback.form.layout_cell_fields_mismatch"
    ), true);
  });

  it("fails readback when a persisted action loses its immutable view gate", () => {
    const dsl = dataOnlyDsl();
    const { readback } = persistAndVerify(dsl, {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        const dispatcher = attr.controlAction.global.onLoad[0];
        dispatcher.function = dispatcher.function.replace(
          "if (MKXFORM.viewStatus !== \"view\") return;",
          "if (false) return;"
        );
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    const gateDiagnostics = readback.diagnostics.filter((item) => item.code === "readback.scripts.run_when_mismatch");
    assert.equal(readback.ok, false);
    assert.equal(gateDiagnostics.length >= 1, true);
  });
});

function runPersistedAction(action, viewStatus) {
  const calls = [];
  const MKXFORM = {
    viewStatus,
    getValue(id) {
      calls.push(["getValue", id]);
      return undefined;
    },
    setValue(id, value) {
      calls.push(["setValue", id, value]);
    }
  };
  const handler = Function("MKXFORM", `${action.function}\nreturn ${action.name}`)(MKXFORM);
  handler({});
  return calls;
}
