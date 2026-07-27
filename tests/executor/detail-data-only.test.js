import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleForm, sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { persistAndVerify, xformConfig } from "../helpers/persistence.js";

describe("persisted data-only detail columns", () => {
  it("keeps the helper addressable in row data and omits its rendered control", () => {
    const { template, readback } = persistAndVerify(detailDataOnlyDsl());
    const { detailModel, detailRef, helper } = nativeDetailEvidence(template);
    const readbackTable = readback.form.fields.find((field) => field.id === "fd_detail");
    const readbackHelper = readbackTable.columns.find((column) =>
      column.id === "fd_helper"
    );
    const helperControl = JSON.parse(helper.fdAttribute).config.controlProps;

    assert.equal(helper.fdIsStored, true);
    assert.equal(helper.fdDisplay, false);
    assert.equal(helperControl.name, "fd_helper");
    assert.equal(helperControl["$$tableName"], detailModel.fdTableName);
    assert.equal(helperControl["$$tableType"], "detail");
    assert.deepEqual(detailRef.children.map((child) => child.key), ["fd_name"]);
    assert.equal(readbackHelper.dataOnly, true);
    assert.deepEqual(readbackTable.renderedColumnIds, ["fd_name"]);
    assert.deepEqual(readbackTable.renderedColumnIdsByScene, {
      desktop: ["fd_name"],
      mobile: ["fd_name"]
    });
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
  });

  it("fails readback if the stored helper becomes displayable or enters render children", () => {
    const displayable = persistAndVerify(detailDataOnlyDsl(), {
      mutate(template) {
        const { config, helper } = nativeDetailEvidence(template);
        helper.fdDisplay = true;
        rewriteConfig(template, config);
        return template;
      }
    }).readback;

    const renderedByScene = ["desktop", "mobile"].map((scene) =>
      persistAndVerify(detailDataOnlyDsl(), {
        mutate(template) {
          const { config, view } = nativeDetailEvidence(template);
          const detailModel = config.dataModel.find((model) =>
            model.fdType === "detail" &&
            model.dynamicProps?.detailFieldName === "fd_detail"
          );
          const sceneRoot = view.view.render[scene][0];
          const detailRef = findNode(
            sceneRoot,
            (node) => node.key === detailModel.fdTableName
          );
          detailRef.children.push({ key: "fd_helper" });
          config.viewModel[0].fdConfig = JSON.stringify(view);
          rewriteConfig(template, config);
          return template;
        }
      }).readback
    );

    assert.equal(displayable.ok, false);
    assert.equal(
      displayable.diagnostics.some((item) =>
        item.code === "readback.form.detail_column_data_only_flag_mismatch"
      ),
      true
    );
    for (const [index, rendered] of renderedByScene.entries()) {
      assert.equal(rendered.ok, false);
      assert.equal(
        rendered.diagnostics.some((item) =>
          item.code === "readback.form.detail_data_only_column_rendered" &&
          item.details?.scene === ["desktop", "mobile"][index]
        ),
        true
      );
    }
  });

  for (const mutation of [
    {
      name: "is missing",
      code: "readback.decode.viewModel.render_scene_missing",
      mutate(view) {
        delete view.view.render.mobile;
      }
    },
    {
      name: "has the wrong type",
      code: "readback.decode.viewModel.render_scene_array_required",
      mutate(view) {
        view.view.render.mobile = {};
      }
    },
    {
      name: "has no readable root",
      code: "readback.decode.viewModel.render_scene_root_required",
      mutate(view) {
        view.view.render.mobile = [];
      }
    }
  ]) {
    it(`fails closed when the mobile render scene ${mutation.name}`, () => {
      const { readback } = persistAndVerify(detailDataOnlyDsl(), {
        mutate(template) {
          const { config, view } = nativeDetailEvidence(template);
          mutation.mutate(view);
          config.viewModel[0].fdConfig = JSON.stringify(view);
          rewriteConfig(template, config);
          return template;
        }
      });

      assert.equal(readback.ok, false);
      assert.equal(readback.partitions.form, "decode_failed");
      assert.equal(
        readback.diagnostics.some((item) => item.code === mutation.code),
        true,
        JSON.stringify(readback.diagnostics)
      );
    });
  }

  it("fails closed when one scene has no detail rendered-column evidence", () => {
    const { readback } = persistAndVerify(detailDataOnlyDsl(), {
      mutate(template) {
        const { config, detailModel, view } = nativeDetailEvidence(template);
        const mobileDetailRef = findNode(
          view.view.render.mobile[0],
          (node) => node.key === detailModel.fdTableName
        );
        mobileDetailRef.key = "unexpected-detail-table";
        config.viewModel[0].fdConfig = JSON.stringify(view);
        rewriteConfig(template, config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(readback.partitions.form, "mismatch");
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.form.detail_render_scene_missing" &&
        item.details?.scene === "mobile"
      ),
      true,
      JSON.stringify(readback.diagnostics)
    );
  });
});

function detailDataOnlyDsl() {
  const form = sampleForm();
  form.fields.find((field) => field.id === "fd_detail").columns.push({
    id: "fd_helper",
    title: "Stored helper",
    type: "text",
    componentId: "xform-input",
    props: {},
    sourceProps: {
      metadataAttributes: {
        canDisplay: "false",
        canShow: "false",
        showStatus: "noShow"
      }
    },
    sourceRef: "source.form.detailTable.fd_detail.column.fd_helper",
    dataOnly: true
  });
  return sampleTrustedDsl({ form, workflow: null });
}

function nativeDetailEvidence(template) {
  const config = xformConfig(template);
  const detailModel = config.dataModel.find((model) =>
    model.fdType === "detail" && model.dynamicProps?.detailFieldName === "fd_detail"
  );
  const helper = detailModel.fdFields.find((field) => field.fdName === "fd_helper");
  const view = JSON.parse(config.viewModel[0].fdConfig);
  const detailRef = findNode(view, (node) => node.key === detailModel.fdTableName);
  return { config, detailModel, detailRef, helper, view };
}

function rewriteConfig(template, config) {
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
}

function findNode(value, predicate) {
  if (!value || typeof value !== "object") return undefined;
  if (predicate(value)) return value;
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    const found = findNode(entry, predicate);
    if (found) return found;
  }
  return undefined;
}
