import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");

describe("workflow completion-notifications native evidence", () => {
  it("writes both end notifications and rejects either value being lost on readback", () => {
    const dsl = completionNotificationsDsl();
    const prepared = prepareSample(dsl);
    const healthyContent = workflowContent(prepared.update);
    const healthy = prepared.verify(independentNativeReadback());

    assert.equal(healthyContent.notifyDrafterOnEnd, "true");
    assert.equal(healthyContent.notifyParticipantOnEnd, "true");
    assert.equal(healthy.ok, true, JSON.stringify(healthy.diagnostics));
    assert.deepEqual(healthy.workflow.completionNotifications, {
      drafter: true,
      participants: true
    });

    for (const key of ["notifyDrafterOnEnd", "notifyParticipantOnEnd"]) {
      const template = independentNativeReadback();
      const content = workflowContent(template);
      content[key] = "false";
      template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(content);
      const mutated = prepared.verify(template);

      assert.equal(mutated.ok, false, `${key}: ${JSON.stringify(mutated.diagnostics)}`);
      assert.equal(mutated.partitions.workflow, "mismatch");
      assert.equal(
        mutated.diagnostics.some((item) =>
          item.code === "readback.workflow.completion_notification_mismatch"
        ),
        true
      );
    }
  });

  it("fails closed when either required native flag is missing, malformed, or wrong-typed", () => {
    const dsl = completionNotificationsDsl({
      drafter: false,
      participants: false
    });
    const prepared = prepareSample(dsl);

    for (const key of ["notifyDrafterOnEnd", "notifyParticipantOnEnd"]) {
      for (const mutation of [
        {
          label: "missing",
          apply(content) {
            delete content[key];
          }
        },
        {
          label: "malformed",
          apply(content) {
            content[key] = "yes";
          }
        },
        {
          label: "wrong-typed",
          apply(content) {
            content[key] = false;
          }
        }
      ]) {
        const template = independentNativeReadback({
          drafter: "false",
          participants: "false"
        });
        const content = workflowContent(template);
        mutation.apply(content);
        template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(content);
        const mutated = prepared.verify(template);

        assert.equal(
          mutated.ok,
          false,
          `${key}/${mutation.label}: ${JSON.stringify(mutated.diagnostics)}`
        );
        assert.equal(mutated.partitions.workflow, "decode_failed");
        assert.equal(
          mutated.diagnostics.some((item) =>
            item.code.startsWith("readback.decode.workflow.completion_notification_") &&
            item.decodePath?.endsWith(`/${key}`)
          ),
          true,
          `${key}/${mutation.label}: ${JSON.stringify(mutated.diagnostics)}`
        );
      }
    }
  });
});

function independentNativeReadback({
  drafter = "true",
  participants = "true"
} = {}) {
  const template = JSON.parse(
    readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8")
  );
  const config = xformConfig(template);
  const formAttr = JSON.parse(config.attribute.formAttr);
  formAttr.subjectRule = {};
  config.attribute.formAttr = JSON.stringify(formAttr);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);

  const workflow = JSON.parse(
    readFileSync(join(fixtureDir, "workflow-completion-notifications-native.json"), "utf8")
  );
  workflow.notifyDrafterOnEnd = drafter;
  workflow.notifyParticipantOnEnd = participants;
  template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(workflow);
  return template;
}

function completionNotificationsDsl(completionNotifications = {
  drafter: true,
  participants: true
}) {
  return sampleTrustedDsl({
    workflow: {
      process: {
        id: "process-1",
        completionNotifications
      }
    }
  });
}

function workflowContent(template) {
  return JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent);
}
