import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTransferRecordPayload,
  generateTransferRecordId,
  TRANSFER_RECORD_ENDPOINT_PATH,
  TRANSFER_RECORD_ENDPOINT_URL
} from "../../src/executor/transfer-record.js";

const expected = JSON.parse(readFileSync(
  new URL("../fixtures/route-validation/transfer-record/expected-transfer-record.json", import.meta.url),
  "utf8"
));

describe("transfer record contract", () => {
  it("builds a form-only transfer record from the source template identity", () => {
    const payload = buildTransferRecordPayload({
      derivedFrom: { sourceId: "199e720f5b997192f37a0ca4728b281f" },
      template: { name: "xieyy分类2模板205" }
    }, {
      fdId: "1j7jicsdnw1ef0wcjew2r072ra16f5sn02w0",
      targetTemplateId: "1j7jics3fw1ef0wcj5w15hohgf2brieo8dw0",
      now: new Date(1760519680440)
    });

    assert.equal(TRANSFER_RECORD_ENDPOINT_PATH, expected.endpointPath);
    assert.equal(TRANSFER_RECORD_ENDPOINT_URL, expected.endpointUrl);
    assert.deepEqual(payload, {
      fdId: "1j7jicsdnw1ef0wcjew2r072ra16f5sn02w0",
      ...expected.fixedFields,
      fdOriginalId: "199e720f5b997192f37a0ca4728b281f",
      fdTargetId: "1j7jics3fw1ef0wcj5w15hohgf2brieo8dw0",
      fdName: "xieyy分类2模板205",
      fdCreateTime: 1760519680440
    });
  });

  it("prefers the paired workflow source template id over the source-directory id", () => {
    const payload = buildTransferRecordPayload({
      derivedFrom: { sourceId: "paired-directory-name" },
      template: { name: "配对流程模板" },
      workflow: {
        process: { templateId: "paired-source-template-id" }
      }
    }, {
      fdId: "000000000000000000000000000000000000",
      targetTemplateId: "target-template-id",
      now: new Date(1760519680440)
    });

    assert.equal(payload.fdOriginalId, "paired-source-template-id");
  });

  it("generates unique 36-character lowercase alphanumeric record ids", () => {
    const ids = Array.from({ length: 32 }, () => generateTransferRecordId());

    assert.equal(ids.every((id) => /^[a-z0-9]{36}$/.test(id)), true);
    assert.equal(new Set(ids).size, ids.length);
  });
});
