import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runFixtureRouteCase } from "./run-route-case.js";

const relativePath = "rich-text-native-length/rich-text-length_SysFormTemplate.xml";
const fixture = `tests/fixtures/route-validation/${relativePath}`;
const stages = () => {
  const source = cleanSourceFile(fixture);
  const dsl = createTrustedMigrationDsl(source, draftSourceDraft(source), {
    externalAgentReviewed: true,
    reviewerName: "rich-text-length-route"
  });
  assert.equal(checkTrust(source, dsl).ok, true);
  return { source, dsl };
};
const nativeField = (config, id) => config.dataModel.flatMap(model => model.fdFields || []).find(field => field.fdName === id);

describe("rich text native model length retention", () => {
  it("keeps designer and metadata rich-text caps in both persistent representations", () => {
    const { dsl } = stages();
    const prepared = prepareSample(dsl), config = xformConfig(prepared.update);
    for (const [id, cap] of [["fd_rich_limited", 600], ["fd_rich_metadata", 1000000]]) {
      const declared = dsl.form.fields.find(field => field.id === id), native = nativeField(config, id);
      assert.equal(declared.componentId, "xform-rich-text");
      assert.equal(declared.props.maxLength, cap);
      assert.equal(native.fdType, "richtext");
      assert.equal(native.fdDataType, "clob");
      assert.equal(native.fdLength, cap, "Model metadata must not reintroduce a 200-character cap when the native definition is rebuilt");
      assert.equal(JSON.parse(native.fdAttribute).config.controlProps.maxLength, cap);
    }
    assert.equal(nativeField(config, "fd_plain_area").fdLength, 2000);
    assert.equal(nativeField(config, "fd_code").fdLength, 18);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });

  for (const representation of ["model", "control", "both"]) {
    it(`rejects a ${representation} cap reset to 200 through independent readback`, () => {
      const { dsl } = stages(), prepared = prepareSample(dsl);
      const changed = structuredClone(prepared.update), config = xformConfig(changed);
      const field = nativeField(config, "fd_rich_limited");
      if (representation !== "control") field.fdLength = 200;
      if (representation !== "model") {
        const attribute = JSON.parse(field.fdAttribute);
        attribute.config.controlProps.maxLength = 200;
        field.fdAttribute = JSON.stringify(attribute);
      }
      changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
      const result = prepared.verify(changed);
      assert.equal(result.ok, false, "A readback with a lost declared cap must not be accepted or registered");
      assert.notEqual(result.partitions.form, "verified");
    });
  }

  it("runs XML review, trust, dry-run, fake new-draft persistence, readback and registration without network", async () => {
    const result = await runFixtureRouteCase({
      id: "rich-text-native-length-success",
      source: { kind: "form-only", relativePath },
      reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
      expected: {
        reviewStatus: "needs_manual", dryRunStatus: "needs_manual", executionStatus: "written_with_warnings",
        operations: ["login", "init", "generate-table-name", "load-parent-category", "add", "get-before-update", "update", "get-readback", "add-transfer-record"]
      }
    });
    assert.equal(result.execution.readback.ok, true);
    assert.equal(result.execution.transferRecord.status, "recorded");
  });
});
