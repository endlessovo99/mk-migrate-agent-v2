import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

const expectedLink =
  "http://kms.shanghai-electric.com/kms/multidoc/kms_multidoc_knowledge/" +
  "kmsMultidocKnowledge.do?method=view&fdId=18e5f7972ce8d1c7e96e8354bc69fea5";

describe("linked description route projection", { concurrency: false }, () => {
  it("persists fd_col_4qkbo3 as a non-stored description with a scalar link", async () => {
    const result = await runRouteCase("link-label-description-success");
    const dslField = result.dsl.form.fields.find((field) => field.id === "fd_col_4qkbo3");
    const nativeField = result.execution.readback.form.fields.find(
      (field) => field.id === "fd_col_4qkbo3"
    );

    assert.equal(dslField?.type, "description");
    assert.equal(dslField?.componentId, "xform-description");
    assert.deepEqual(dslField?.props, {
      content: "请点击查看采购需求清单模板",
      hasLink: true,
      link: expectedLink
    });
    assert.equal(nativeField?.type, "desc");
    assert.equal(nativeField?.component, "xform-description");
    assert.equal(nativeField?.content, "请点击查看采购需求清单模板");
    assert.equal(nativeField?.hasLink, true);
    assert.equal(nativeField?.link, expectedLink);
  });
});
