import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeDsl } from "../../src/executor/execute.js";
import {
  resolveStaticAddressDefaults,
  StaticAddressDefaultResolutionError
} from "../../src/executor/static-address-default-resolver.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("static address default target validation", () => {
  it("accepts one exact target with an allowed organization type", async () => {
    const result = await resolveStaticAddressDefaults(dsl(), {
      client: clientReturning({ fdId: "fixed-org", fdName: "Fixed Organization", fdOrgType: 2 })
    });
    assert.equal(result.resolvedCount, 1);
    assert.equal(result.identityCount, 1);
  });

  for (const [name, target, reason] of [
    ["missing target", undefined, "not_found"],
    ["renamed target", { fdId: "fixed-org", fdName: "Renamed Organization", fdOrgType: 2 }, "name_mismatch"],
    ["disallowed target type", { fdId: "fixed-org", fdName: "Fixed Organization", fdOrgType: 8 }, "type_mismatch"]
  ]) {
    it(`blocks ${name} before persistence`, async () => {
      await assert.rejects(
        resolveStaticAddressDefaults(dsl(), { client: clientReturning(target) }),
        (error) => {
          assert.equal(error instanceof StaticAddressDefaultResolutionError, true);
          assert.equal(error.stage, "resolveStaticAddressDefaults");
          assert.equal(error.code, "form.static_address_default_resolution_failed");
          assert.equal(error.issues[0].reason, reason);
          return true;
        }
      );
    });
  }

  it("blocks execute before init or add when the target does not exist", async () => {
    const input = sampleTrustedDsl();
    input.form.fields.push({
      id: "fd_company",
      title: "申请公司",
      type: "text",
      componentId: "xform-address",
      props: {
        orgTypes: ["ORG_TYPE_ORG", "ORG_TYPE_DEPT"],
        defaultValue: { kind: "staticOrg", id: "missing-org", name: "Missing Organization" }
      },
      sourceProps: { designerType: "address" },
      sourceRef: "source.form.control.fd_company"
    });
    const calls = [];
    const client = {
      async login() { calls.push("login"); },
      assertTransferRecordAuthentication() {},
      async getElementInfo() { calls.push("get-element-info"); return []; },
      async addTransferRecord() { calls.push("add-transfer-record"); }
    };

    const result = await executeDsl(input, {
      client,
      confirmWrite: true,
      targetCategoryId: "route-category-id",
      baseUrl: "https://p-sit.onewo.com",
      credentials: { username: "fixture-user", encryptedPassword: "fixture-password" },
      transferRecordIdFactory: () => "route0000000000000000000000000000000"
    });

    assert.equal(result.ok, false);
    assert.equal(result.stage, "resolveStaticAddressDefaults");
    assert.deepEqual(result.createdFdIds, []);
    assert.deepEqual(result.updatedFdIds, []);
    assert.deepEqual(calls, ["login", "get-element-info"]);
    assert.equal(result.apiStages.some((stage) => ["init", "add"].includes(stage.name)), false);
  });
});

function dsl() {
  return {
    form: {
      fields: [{
        id: "fd_company",
        componentId: "xform-address",
        props: {
          orgTypes: ["ORG_TYPE_ORG", "ORG_TYPE_DEPT"],
          defaultValue: { kind: "staticOrg", id: "fixed-org", name: "Fixed Organization" }
        }
      }]
    }
  };
}

function clientReturning(target) {
  return {
    async getElementInfo() {
      return target ? [target] : [];
    }
  };
}
