import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftSourceDraft, cleanSourceFile } from "../../src/translator/index.js";

const fixturePath = "tests/fixtures/source/18aac2e235a65c382f6fe264e1dba521";

describe("unbound leading subject captions", () => {
  it("uses visible textLabel captions as titles for unbound invoice subjects", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixturePath));
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));

    assert.equal(fields.get("fd_3c539454d0fdf6")?.title, "建筑服务发生省市");
    assert.deepEqual(fields.get("fd_3c539454d0fdf6")?.sourceProps.inlineCaption, {
      id: "fd_3c5394120cadc8",
      content: "建筑服务发生省市",
      relation: "leading-unbound-subject-caption"
    });
    assert.deepEqual(fields.get("fd_3c539454d0fdf6")?.sourceProps.subjectLabel, {
      content: "建筑服务省市",
      relation: "unbound-control-subject-distinct-from-visible-caption"
    });
    assert.equal(fields.has("fd_3c5394120cadc8"), false);

    assert.equal(fields.get("fd_3c539457ff1db0")?.title, "建筑服务发生所在详细地址");
    assert.deepEqual(fields.get("fd_3c539457ff1db0")?.sourceProps.subjectLabel, {
      content: "建筑服务详细地址",
      relation: "unbound-control-subject-distinct-from-visible-caption"
    });
    assert.equal(fields.has("fd_3c53941e6eb7ba"), false);
  });
});
