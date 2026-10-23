import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { resolveTargetApiCall } from "../../src/dsl/target-api-catalog.js";

const fixtureRoot = new URL("../fixtures/executor/persistence/choice-other-runtime/", import.meta.url);
const contract = JSON.parse(readFileSync(new URL("contract.json", fixtureRoot), "utf8"));
const digest = text => createHash("sha256").update(text).digest("hex");

for (const [platform, evidence] of [["desktop", contract], ["mobile", contract.mobile]]) {
  const nativeSource = readFileSync(new URL(evidence.extracted.file, fixtureRoot), "utf8");
  const subscriptionRuntime = config => createSubscriptionRuntime(config, nativeSource);

  describe(`native choice companion value subscription (${platform})`, () => {
    it("retains the unchanged native subscription function with bounded provenance", () => {
      assert.equal(digest(nativeSource), evidence.extracted.sha256);
      const functionSource = nativeSource.trim().slice(1, -1);
      assert.equal(digest(functionSource), evidence.extracted.functionSha256);
      assert.equal(functionSource.length, evidence.extracted.endUtf16 - evidence.extracted.startUtf16);
      assert.equal(evidence.source.sha256, platform === "desktop"
        ? "82b02f1f8eef7ca7c9b7c8fbde378810f8c8ea6e54805e69caef16f1ee64157b"
        : "dbe2e7f6f4cddf924623f4a025080ff703015f7cfb39231b9ee2e18a019d01a6");
      assert.match(evidence.source.asset, new RegExp(`/sys-xform/${platform}/api/MKXFORMFACTORY/index\\.js\\?`));
      for (const fragment of evidence.staticEvidence) {
        assert.equal(digest(fragment.text), fragment.sha256, fragment.name);
        assert.equal(fragment.text.length, fragment.endUtf16 - fragment.startUtf16, fragment.name);
      }
      assert.match(contract.verifiedScope, /does not instantiate the complete React form/);
    });

    it("admits the captured public API through its actual catalog snippet", () => {
      const api = resolveTargetApiCall("MKXFORM.onChange");
      assert.equal(api.safety, "safe");
      assert.equal(api.snippetName, "onChange");
      assert.equal(api.categoryId, "event");
      assert.match(api.evidence, /MKXFORM\.onChange\(/);
      assert.equal(resolveTargetApiCall("MKXFORM.onChangeUnknown").safety, "unknown");
    });

    it("subscribes under the resolved native field key and preserves arbitrary companion text", () => {
      const runtime = subscriptionRuntime();
      const values = [];
      assert.equal(runtime.subscribe("fd_note", (...args) => values.push(args), runtime.context), undefined);
      assert.equal(runtime.subscriptions[0].key, "native_main.fd_note");
      for (const value of ["  保留_完整_说明  ", "", null, undefined]) {
        runtime.subscriptions[0].callback({ "native_main.fd_note": value });
        assert.equal(values.at(-1)[0], value);
        assert.equal(values.at(-1)[1], null);
      }
      assert.deepEqual(runtime.resolutions, [["fd_note", runtime.context]]);
    });

    it("forwards checkbox arrays without encoding, sorting or filtering source option codes", () => {
      const runtime = subscriptionRuntime({ key: "native_main.fd_choice", type: "@elem/xform-checkbox" });
      let received;
      runtime.subscribe("fd_choice", value => { received = value; }, runtime.context);
      for (const sourceValues of [[], ["O_CODE", "A", "other_legacy_code"]]) {
        const before = [...sourceValues];
        runtime.subscriptions[0].callback({ "native_main.fd_choice": sourceValues });
        assert.equal(received, sourceValues);
        assert.deepEqual(sourceValues, before);
      }
    });

    for (const type of ["@elem/xform-detail-table", "@elem/xform-m-detail-table"]) {
      it(`passes native detail deltas and suppresses empty detail changes for ${type}`, () => {
        const runtime = subscriptionRuntime({ key: "native_detail", type });
        const calls = [];
        runtime.subscribe("fd_detail", (...args) => calls.push(args), runtime.context);
        const value = [{ key: "row-1", fd_note: "a_b" }];
        runtime.detailDelta = { "row-1": { fd_note: "a_b" } };
        runtime.subscriptions[0].callback({ native_detail: value });
        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], value);
        assert.equal(calls[0][1], runtime.detailDelta);
        runtime.detailDelta = {};
        runtime.subscriptions[0].callback({ native_detail: value });
        assert.equal(calls.length, 1);
      });
    }

    it("does not subscribe when the field config or native form is unavailable", () => {
      const missingConfig = subscriptionRuntime(null);
      missingConfig.subscribe("fd_missing", () => assert.fail("unresolved field fired"), missingConfig.context);
      assert.equal(missingConfig.subscriptions.length, 0);
      const missingForm = subscriptionRuntime();
      missingForm.form = null;
      missingForm.subscribe("fd_note", () => assert.fail("missing form fired"), missingForm.context);
      assert.equal(missingForm.subscriptions.length, 0);
    });

    it("preserves the native duplicate-registration behavior so initialization must guard it", () => {
      const runtime = subscriptionRuntime();
      const observed = [];
      const callback = value => observed.push(value);
      runtime.subscribe("fd_note", callback, runtime.context);
      runtime.subscribe("fd_note", callback, runtime.context);
      assert.equal(runtime.subscriptions.length, 2);
      for (const subscription of runtime.subscriptions) subscription.callback({ "native_main.fd_note": "note" });
      assert.deepEqual(observed, ["note", "note"]);
    });
  });
}

// Only dependency boundaries are fake. The subscription adapter executed above
// is the unchanged SDK function, not a reimplementation of its dispatch logic.
function createSubscriptionRuntime(config = { key: "native_main.fd_note", type: "@elem/xform-input" }, nativeSource) {
  const runtime = { context: {}, resolutions: [], subscriptions: [], detailDelta: null };
  runtime.form = {
    customOnChange(callback, key) {
      runtime.subscriptions.push({ callback, key });
      return { deleteCustomEvent() {} };
    }
  };
  runtime.subscribe = runInNewContext(nativeSource, {
    r: { getConfig(id, context) { runtime.resolutions.push([id, context]); return config; } },
    o: {
      $$form(context) { assert.equal(context, runtime.context); return runtime.form; },
      $$detailForms(context) {
        assert.equal(context, runtime.context);
        return { [config.key]: { current: { getTinyValues() { return runtime.detailDelta; } } } };
      }
    }
  });
  return runtime;
}
