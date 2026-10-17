import assert from "node:assert/strict";
import { it } from "node:test";
import { NewoaClient } from "../../src/executor/newoa-client.js";
import { withNetworkGuard } from "../route-validation/network-guard.js";

const response = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

it("reads only exact native TIC metadata endpoints with identity and successful wrapper validation", async () => withNetworkGuard(async () => {
  const calls = [], client = new NewoaClient({ baseUrl: "https://qas.example.invalid", fetchImpl: async (url, options) => {
    calls.push({ url, options }); return response({ success: true, data: { fdId: JSON.parse(options.body).fdId, fdType: "REST" } });
  } });
  client.cookie = "fixture-session=value"; client.token = "fixture-token";
  assert.equal((await client.getTicInterface("fixture_interface")).fdId, "fixture_interface");
  assert.equal((await client.getTicConnection("fixture_connection")).fdId, "fixture_connection");
  assert.deepEqual(calls.map(call => ({ url: call.url, body: JSON.parse(call.options.body), method: call.options.method })), [
    { url: "https://qas.example.invalid/data/tic-definition/ticDefInterface/load", body: { fdId: "fixture_interface" }, method: "POST" },
    { url: "https://qas.example.invalid/data/tic-definition/ticDefConnection/get", body: { fdId: "fixture_connection" }, method: "POST" }
  ]);
  for (const call of calls) {
    assert.equal(call.options.headers.cookie, "fixture-session=value"); assert.equal(call.options.headers.Authorization, "Bearer fixture-token");
    assert.equal(/execute|executeForAjax|\/add|\/update/.test(call.url), false);
  }
}));

it("rejects malformed identities before transport and never exposes native error body or credentials", async () => {
  for (const method of ["getTicInterface", "getTicConnection"]) {
    let count = 0;
    const client = new NewoaClient({ fetchImpl: async () => { count += 1; return response({ success: true, data: { fdId: "fixture_id" } }); } });
    for (const value of [undefined, "", " spaced ", "../../execute", "id?token=secret", ["fixture_id"]]) {
      await assert.rejects(() => client[method](value), error => error.stage === method);
    }
    assert.equal(count, 0);
    for (const body of [{ data: { fdId: "fixture_id" } }, { success: true, data: { fdId: "different_id", password: "private-secret" } },
      { success: false, msg: "https://upstream.example.invalid/?password=private-secret" }, { success: true, data: [] }]) {
      client.fetch = async () => response(body);
      await assert.rejects(() => client[method]("fixture_id"), error => {
        assert.equal(error.stage, method); assert.equal(JSON.stringify(error).includes("private-secret"), false);
        assert.equal(error.message.includes("upstream.example.invalid"), false); assert.equal(error.response, undefined); return true;
      });
    }
    client.fetch = async () => { throw new Error("private-secret transport body"); };
    await assert.rejects(() => client[method]("fixture_id"), error => error.stage === method && !error.message.includes("private-secret"));
  }
});
