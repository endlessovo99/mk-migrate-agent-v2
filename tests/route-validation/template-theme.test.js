import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { executeDsl } from "../../src/executor/execute.js";
import { prepareRequiredTemplateTheme } from "../../src/executor/template-theme.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { projectTemplate } from "../helpers/persistence.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { runRouteCase } from "./run-route-case.js";

const contract = JSON.parse(readFileSync(
  new URL("../fixtures/route-validation/template-theme/contract.json", import.meta.url), "utf8"
));

describe("classic theme route", { concurrency: false }, () => {
  it("saves both themes in the existing update and verifies them before recording transfer", async () => {
    const route = await runRouteCase("form-only-success");
    const client = new ThemeAdapter();
    const result = await execute(route.dsl, client);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.readback.theme, { contractVersion: 1, status: "verified", ...contract.theme });
    assert.deepEqual(route.dryRun.steps.find((step) => step.id === "save-template-draft").theme, contract.theme);
    assert.deepEqual(route.dryRun.steps.find((step) => step.id === "readback").expectedTheme, contract.theme);
    assert.equal(client.entries.filter((entry) => entry.operation === "update").length, 1);
    assert.equal(client.entries.at(-1).operation, "add-transfer-record");
    const view = firstView(client.saved);
    assert.equal(view.theme.desktop.name, "classic");
    assert.equal(view.theme.mobile.name, "classic");
    assert.equal(view.theme.mobile.viewAttr.mobileTheme, "classic");
    assert.equal(view.theme.desktop.viewAttr.desktopTitleBgColor, contract.desktop.titleBackground);
    assert.equal(view.controlStyle.fd_subject.desktop.desktopGridItemStyle.borderBottom, contract.desktop.gridBorder);
    assert.equal(view.controlStyle.fd_subject.mobile.layout, contract.mobile.layout);
    assert.equal(JSON.stringify(view).includes("fd_col_pfyivn"), false);
  });

  for (const failure of contract.failureCases) {
    it(`fails readback without a callback or repeated update: ${failure}`, async () => {
      const { dsl } = await runRouteCase("form-only-success");
      const client = new ThemeAdapter(failure);
      const result = await execute(dsl, client);
      assert.equal(result.ok, false);
      assert.equal(result.status, "readback_failed");
      assert.equal(result.readback.theme.status, "mismatch");
      assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "readback.theme.mismatch"));
      assert.equal(client.entries.filter((entry) => entry.operation === "update").length, 1);
      assert.equal(client.entries.some((entry) => entry.operation === "add-transfer-record"), false);
      assert.deepEqual(result.createdFdIds, ["route-created-template"]);
    });
  }

  it("styles actual main/detail references and preserves all non-theme business data", () => {
    const original = projectTemplate(sampleTrustedDsl());
    const before = structuredClone(original);
    const themed = prepareRequiredTemplateTheme(original);
    assert.deepEqual(original, before);
    const config = formConfig(themed.update);
    const view = firstView(themed.update);
    const detailTable = config.dataModel.find((model) => model.fdType === "detail").fdTableName;
    for (const id of ["fd_subject", "fd_amount", detailTable, "fd_name"]) {
      assert.equal(view.controlStyle[id].desktop.desktopTheme, "classic", id);
      assert.equal(view.controlStyle[id].mobile.mobileTheme, "classic", id);
    }
    const restored = structuredClone(themed.update);
    const restoredConfig = formConfig(restored);
    restoredConfig.viewModel.forEach((model, index) => {
      const current = JSON.parse(model.fdConfig);
      const prior = JSON.parse(formConfig(before).viewModel[index].fdConfig);
      current.theme = prior.theme;
      current.controlStyle = prior.controlStyle;
      model.fdConfig = JSON.stringify(current);
    });
    restored.mechanisms["sys-xform"].fdConfig = JSON.stringify(restoredConfig);
    assert.deepEqual(restored, before);
    assert.equal(themed.verify({ ok: true, status: "verified" }, themed.update).ok, true);
  });

  it("preserves source description emphasis on both scenes without inventing an absent color", async () => {
    const { dsl } = await runRouteCase("link-label-description-success");
    const template = projectTemplate(dsl);
    const config = formConfig(template);
    const view = JSON.parse(config.viewModel[0].fdConfig);
    const id = "fd_col_4qkbo3";
    view.controlStyle[id].desktop.controlValueStyle = contract.description;
    config.viewModel[0].fdConfig = JSON.stringify(view);
    template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    const themed = firstView(prepareRequiredTemplateTheme(template).update);
    for (const scene of ["desktop", "mobile"]) {
      assert.deepEqual(themed.controlStyle[id][scene].controlValueStyle, contract.description);
      assert.equal(themed.controlStyle[id][scene].layout, "vertical");
    }
    const unstyled = firstView(prepareRequiredTemplateTheme(projectTemplate(dsl)).update);
    assert.equal(unstyled.controlStyle[id].desktop.controlValueStyle, undefined);
  });

  it("verifies the projected theme even when a client mutates its write argument", () => {
    const themed = prepareRequiredTemplateTheme(projectTemplate(sampleTrustedDsl()));
    changeView(themed.update, (view) => { view.theme.mobile.name = "default"; });
    assert.equal(themed.verify({ ok: true, status: "verified" }, themed.update).ok, false);
  });
});

class ThemeAdapter extends FakeNewoaAdapter {
  constructor(failure) {
    super("persist");
    this.failure = failure;
  }
  async updateTemplate(payload) {
    this.saved = structuredClone(payload);
    return super.updateTemplate(payload);
  }
  async getTemplate(id) {
    const template = await super.getTemplate(id);
    if (this.updated && this.failure) {
      changeView(template, (view) => {
        if (this.failure === "drop-theme") delete view.theme;
        if (this.failure === "desktop-default") view.theme.desktop.name = "default";
        if (this.failure === "mobile-default") view.theme.mobile.name = "default";
        if (this.failure === "mobile-selector") view.theme.mobile.viewAttr.mobileTheme = "default";
        if (this.failure === "drop-styles") view.controlStyle = {};
        if (this.failure === "desktop-border") view.controlStyle.fd_subject.desktop.desktopGridItemStyle.borderBottom = "none";
        if (this.failure === "mobile-value") view.controlStyle.fd_subject.mobile.controlValueStyle.color = "#FFFFFF";
      });
      if (this.failure === "invalid-view") {
        const config = formConfig(template);
        config.viewModel[0].fdConfig = "{}";
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
      }
    }
    return template;
  }
}

function execute(dsl, client) {
  return executeDsl(dsl, {
    client,
    credentials: { username: "route-test-user", encryptedPassword: "route-test-encrypted-password" },
    confirmWrite: true,
    targetCategoryId: "route-category-id",
    now: new Date("2026-07-10T00:00:00.000Z")
  });
}
function formConfig(template) { return JSON.parse(template.mechanisms["sys-xform"].fdConfig); }
function firstView(template) { return JSON.parse(formConfig(template).viewModel[0].fdConfig); }
function changeView(template, change) {
  const config = formConfig(template);
  const view = JSON.parse(config.viewModel[0].fdConfig);
  change(view);
  config.viewModel[0].fdConfig = JSON.stringify(view);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
}
