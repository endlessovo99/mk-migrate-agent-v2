import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import {
  persistAndVerify,
  projectTemplate,
  summarizeProjectedForm,
  verifyTemplate,
  xformConfig
} from "../helpers/persistence.js";

describe("global singleton script dispatchers", () => {
  it("persists one ordered dispatcher for each singleton global event", async () => {
    const dsl = sampleTrustedDsl({
      workflow: null,
      scripts: {
        actions: [
          mappedGlobalAction("load-1", "onLoad", "MKXFORM.setValue('fd_subject', 'load-1')"),
          mappedGlobalAction("load-2", "onLoad", "MKXFORM.setValue('fd_subject', 'load-2')"),
          mappedGlobalAction("before-1", "onBeforeSubmit", "MKXFORM.setValue('fd_subject', 'before-1'); return true"),
          mappedGlobalAction("before-2", "onBeforeSubmit", "MKXFORM.setValue('fd_subject', 'before-2'); return Promise.resolve(context.allow !== false)"),
          mappedGlobalAction("before-3", "onBeforeSubmit", "MKXFORM.setValue('fd_subject', 'before-3'); return true"),
          mappedGlobalAction(
            "after-1",
            "onAfterSubmit",
            "function onAfterSubmit_2() { MKXFORM.setValue('fd_subject', 'after-1') } onAfterSubmit_2()"
          ),
          mappedGlobalAction("after-2", "onAfterSubmit", "MKXFORM.setValue('fd_subject', 'after-2')")
        ]
      }
    });
    const template = projectTemplate(dsl);
    const config = xformConfig(template);
    const formAttr = JSON.parse(config.attribute.formAttr);
    const global = formAttr.controlAction.global;

    for (const event of ["onLoad", "onBeforeSubmit", "onAfterSubmit"]) {
      assert.equal(global[event].length, 1);
      assert.equal(global[event][0].name, event);
    }
    assert.deepEqual(global.onBeforeSubmit[0].migrationActions.map(({ id, name }) => ({ id, name })), [
      { id: "before-1", name: "onBeforeSubmit_1" },
      { id: "before-2", name: "onBeforeSubmit_2" },
      { id: "before-3", name: "onBeforeSubmit_3" }
    ]);
    assert.deepEqual(global.onAfterSubmit[0].migrationActions.map(({ id, name }) => ({ id, name })), [
      { id: "after-1", name: "onAfterSubmit_1" },
      { id: "after-2", name: "onAfterSubmit_2" }
    ]);
    const summary = summarizeProjectedForm(template).scripts;
    assert.equal(summary.actionCount, 7);
    assert.equal(summary.persistedActionCount, 3);
    assert.deepEqual(summary.dispatchers.map(({ event, strategy }) => ({ event, strategy })), [
      { event: "onLoad", strategy: "ordered" },
      { event: "onBeforeSubmit", strategy: "ordered_await_false_short_circuit" },
      { event: "onAfterSubmit", strategy: "ordered" }
    ]);
    assert.equal(verifyTemplate(dsl, template).ok, true);
    assert.equal(global.onBeforeSubmit[0].function.startsWith("async function onBeforeSubmit"), true);

    const rejectedCalls = await runDispatcher(global.onBeforeSubmit[0], { allow: false });
    assert.equal(rejectedCalls.result, false);
    assert.deepEqual(rejectedCalls.values, ["before-1", "before-2"]);
    const acceptedCalls = await runDispatcher(global.onBeforeSubmit[0], { allow: true });
    assert.equal(acceptedCalls.result, true);
    assert.deepEqual(acceptedCalls.values, ["before-1", "before-2", "before-3"]);
    assert.deepEqual((await runDispatcher(global.onAfterSubmit[0], {})).values, ["after-1", "after-2"]);

    const mutated = persistAndVerify(dsl, {
      mutate(readbackTemplate) {
        const readbackConfig = xformConfig(readbackTemplate);
        const readbackAttr = JSON.parse(readbackConfig.attribute.formAttr);
        readbackAttr.controlAction.global.onBeforeSubmit[0].function =
          readbackAttr.controlAction.global.onBeforeSubmit[0].function.replace("'before-2'", "'corrupted'");
        readbackConfig.attribute.formAttr = JSON.stringify(readbackAttr);
        readbackTemplate.mechanisms["sys-xform"].fdConfig = JSON.stringify(readbackConfig);
        return readbackTemplate;
      }
    }).readback;
    assert.equal(mutated.ok, false);
    assert.equal(mutated.diagnostics.some((item) => item.code === "readback.scripts.body_digest_mismatch"), true);

    const missingCall = persistAndVerify(dsl, {
      mutate(readbackTemplate) {
        const readbackConfig = xformConfig(readbackTemplate);
        const readbackAttr = JSON.parse(readbackConfig.attribute.formAttr);
        readbackAttr.controlAction.global.onBeforeSubmit[0].function =
          readbackAttr.controlAction.global.onBeforeSubmit[0].function.replace(
            "  if (await onBeforeSubmit_2(context) === false) return false;\n",
            "  // if (await onBeforeSubmit_2(context) === false) return false;\n"
          );
        readbackConfig.attribute.formAttr = JSON.stringify(readbackAttr);
        readbackTemplate.mechanisms["sys-xform"].fdConfig = JSON.stringify(readbackConfig);
        return readbackTemplate;
      }
    }).readback;
    assert.equal(missingCall.ok, false);
    assert.equal(missingCall.diagnostics.some((item) => item.code === "readback.scripts.dispatcher_mismatch"), true);
  });
});

function mappedGlobalAction(id, event, body) {
  return {
    id,
    name: event,
    event,
    scope: "global",
    function: `function ${event}(context) { ${body} }`,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: id,
      target: "MKXFORM.setValue",
      basis: "test",
      reviewRequired: false
    }]
  };
}

async function runDispatcher(action, context) {
  const values = [];
  const MKXFORM = {
    setValue(_id, value) {
      values.push(value);
    }
  };
  const handler = Function("MKXFORM", `${action.function}\nreturn ${action.name}`)(MKXFORM);
  return { result: await handler(context), values };
}
