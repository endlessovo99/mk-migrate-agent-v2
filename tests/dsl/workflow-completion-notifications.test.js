import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("workflow completion-notifications DSL", () => {
  it("requires canonical boolean values", () => {
    const wrongShape = sampleTrustedDsl({
      workflow: {
        process: {
          id: "process-1",
          completionNotifications: "enabled"
        }
      }
    });
    const wrongValues = sampleTrustedDsl({
      workflow: {
        process: {
          id: "process-1",
          completionNotifications: {
            drafter: "true",
            participants: 1
          }
        }
      }
    });

    const shapeResult = validateMigrationDsl(wrongShape, { mode: "execute" });
    const valueResult = validateMigrationDsl(wrongValues, { mode: "execute" });

    assert.equal(shapeResult.ok, false);
    assert.equal(
      shapeResult.diagnostics.some((item) =>
        item.code === "dsl.workflow.completion_notifications.type" &&
        item.path === "/workflow/process/completionNotifications"
      ),
      true
    );
    assert.deepEqual(
      valueResult.diagnostics
        .filter((item) => item.code === "dsl.workflow.completion_notifications.boolean_required")
        .map((item) => item.path),
      [
        "/workflow/process/completionNotifications/drafter",
        "/workflow/process/completionNotifications/participants"
      ]
    );
  });
});
