import assert from "node:assert/strict";
import { it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { projectTemplate, xformConfig } from "../helpers/persistence.js";

const source = "tests/fixtures/source/1927955f6e544383f46970f48468a743";

it("routes a nested JSP click handler to an executable MK button draft", () => {
  const sourceDraft = cleanSourceFile(source);
  const dsl = draftSourceDraft(sourceDraft);
  const result = checkDraft(dsl);
  const button = dsl.form.fields.find((field) => field.componentId === "xform-button");
  const click = dsl.scripts.actions.find((action) =>
    action.controlId === button?.id && action.event === "onClick"
  );

  assert.equal(result.ok, true);
  assert.equal(button?.id, "fd_3d7f13d18ccc00");
  assert.equal(click?.translationStatus, "mapped");
  assert.deepEqual(click?.coverage, { status: "translated", nativeRules: [], residuals: [] });

  const calls = { deleted: [], added: [] };
  const executable = click.function
    .replaceAll("${table:fd_3d69ce51f013c0}", "source_detail")
    .replaceAll("${table:fd_3d69cf2b1acb52}", "target_detail");
  const onClick = Function("MKXFORM", `${executable}; return onClick;`)({
    getFormValues() {
      return {
        source_detail: {
          values: [{ fd_model_desc1: "M1", fd_quantity1: 2 }],
          dataState: {},
          deleteState: []
        }
      };
    },
    deleteRow(id) { calls.deleted.push(id); },
    addRow(id, row) { calls.added.push({ id, row }); }
  });
  onClick();

  assert.deepEqual(calls.deleted, ["target_detail"]);
  assert.equal(calls.added.length, 4);
  assert.deepEqual(calls.added[0], {
    id: "target_detail",
    row: {
      fd_model_desc2: "M1",
      fd_quantity2: 2,
      fd_part_type: "STD01",
      fd_part_type2: "STD01"
    }
  });

  const executableDraft = structuredClone(dsl);
  const executableClick = executableDraft.scripts.actions.find((action) => action.event === "onClick");
  const beforeSubmit = executableDraft.scripts.actions.find((action) => action.event === "onBeforeSubmit");
  beforeSubmit.function = "function onBeforeSubmit(context) { if (context.isDraft) return true; return true; }";
  beforeSubmit.translationStatus = "mapped";
  beforeSubmit.coverage = { status: "translated", nativeRules: [], residuals: [] };
  beforeSubmit.functionMappings = [{
    source: "source submit callback",
    target: "boolean return",
    basis: "route-validation",
    reviewRequired: false
  }];
  executableDraft.scripts.actions = [executableClick, beforeSubmit];
  const trusted = createTrustedMigrationDsl(sourceDraft, executableDraft, {
    externalAgentReviewed: true,
    decisions: [{
      id: "jsp-button-sync-script-route",
      status: "accepted",
      decisionType: "route_validation",
      sourceRefs: [...(executableClick.sourceRefs || []), ...(beforeSubmit.sourceRefs || [])],
      targetRefs: [executableClick.id, beforeSubmit.id],
      rationale: "Validate synchronous JSP button and submit scripts through native projection.",
      result: "accepted"
    }]
  });

  assert.equal(checkTrust(sourceDraft, trusted).ok, true);
  const native = projectTemplate(trusted);
  const nativeFormAttr = JSON.parse(xformConfig(native).attribute.formAttr);
  const dispatcher = nativeFormAttr.controlAction.global.onBeforeSubmit[0].function;
  assert.match(dispatcher, /^function onBeforeSubmit\(context\)/);
  assert.doesNotMatch(dispatcher, /\b(?:async|await)\b/);

  const asyncRoute = structuredClone(trusted);
  asyncRoute.scripts.actions[1].function = "async function onBeforeSubmit(context) { if (context.isDraft) return true; await MKXFORM.validateFields(); return true; }";
  assert.equal(checkTrust(sourceDraft, asyncRoute).diagnostics.some((item) =>
    item.code === "dsl.scripts.mk_async_syntax_forbidden"
  ), true);

  const promiseRoute = structuredClone(trusted);
  promiseRoute.scripts.actions[1].function = "function onBeforeSubmit(context) { if (context.isDraft) return true; return (\nPromise.resolve(true)\n); }";
  assert.equal(checkTrust(sourceDraft, promiseRoute).diagnostics.some((item) =>
    item.code === "dsl.scripts.before_submit_promise_forbidden"
  ), true);
});
