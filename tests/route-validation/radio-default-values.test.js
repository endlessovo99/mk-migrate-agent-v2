import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixturePath = "tests/fixtures/source/189438c54dee44ba9869deb439dbc163";

describe("radio default values Route case", () => {
  it("marks numeric source defaults as checked native radio options", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixturePath));
    const prepared = prepareSample(dsl);
    const config = JSON.parse(prepared.update.mechanisms["sys-xform"].fdConfig);
    const fields = config.dataModel.flatMap((model) => model.fdFields || []);
    const expectedDefaults = {
      gsdm: "1500",
      fd_kplx: "0",
      hcsply: "0",
      receiptType: "81"
    };

    for (const [fieldId, expectedValue] of Object.entries(expectedDefaults)) {
      const field = fields.find((candidate) => candidate.fdName === fieldId);
      const props = JSON.parse(field.fdAttribute).config.controlProps;
      const fontData = JSON.parse(field.fdFontExtendData);
      assert.deepEqual(
        props.options.filter((option) => option.checked).map((option) => option.value),
        [expectedValue],
        fieldId
      );
      assert.deepEqual(
        fontData.options.filter((option) => option.checked).map((option) => option.value),
        [expectedValue],
        `${fieldId}.font`
      );
    }
  });
});
