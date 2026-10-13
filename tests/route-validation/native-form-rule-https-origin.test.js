import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  inspectNativeFormRuleRuntimeBundleHashes,
  inspectNativeFormRuleRuntimeDigest
} from "../../src/executor/native-form-rule-runtime-capability.js";

const fixture = JSON.parse(readFileSync(
  new URL("../fixtures/route-validation/native-form-rule-https-origin/verified-bundles.json", import.meta.url),
  "utf8"
));

describe("Shanghai Electric HTTPS native form-rule capability route", () => {
  it("accepts the HTTPS origin with its observed releases and bundle contents", () => {
    const capability = inspectNativeFormRuleRuntimeDigest(fixture.digest, {
      baseUrl: fixture.baseUrl
    });

    assert.equal(capability.ok, true, JSON.stringify(capability.issues));
    assert.equal(capability.deploymentId, fixture.deploymentId);
    assert.equal(inspectNativeFormRuleRuntimeBundleHashes({
      ...fixture.bundleSha256,
      ...capability
    }).ok, true);
  });

  it("rejects the same release pair on an unregistered origin or port", () => {
    for (const baseUrl of [
      "https://unregistered.example.com",
      "https://oaqas.shanghai-electric.com:8443"
    ]) {
      const capability = inspectNativeFormRuleRuntimeDigest(fixture.digest, { baseUrl });
      assert.equal(capability.ok, false, baseUrl);
      assert.deepEqual(capability.issues, [
        "xform_runtime_hash_unrecognized",
        "xform_ide_hash_unrecognized"
      ]);
    }
  });

  it("rejects a changed release for either module on the registered origin", () => {
    for (const key of Object.keys(fixture.digest)) {
      const digest = structuredClone(fixture.digest);
      digest[key].hash = "00000000000000000000000000000000";
      assert.equal(inspectNativeFormRuleRuntimeDigest(digest, {
        baseUrl: fixture.baseUrl
      }).ok, false, key);
    }
  });

  it("rejects changed bundle contents despite matching release hashes", () => {
    const capability = inspectNativeFormRuleRuntimeDigest(fixture.digest, {
      baseUrl: fixture.baseUrl
    });
    assert.equal(capability.ok, true);
    for (const key of Object.keys(fixture.bundleSha256)) {
      const result = inspectNativeFormRuleRuntimeBundleHashes({
        ...fixture.bundleSha256,
        ...capability,
        [key]: "0".repeat(64)
      });
      assert.equal(result.ok, false, key);
      assert.equal(result.issues.length, 1, key);
    }
  });
});
