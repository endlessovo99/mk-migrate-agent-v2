import { readFileSync } from "node:fs";
import vm from "node:vm";

const fixture = new URL("../fixtures/executor/persistence/message-runtime/", import.meta.url);

/** Use the native API factories; only their UI sinks are replaced with recorders. */
export function nativeMessageRuntime(platform = "desktop", onMessage = () => {}) {
  const messages = [], calls = [];
  function record(method, content, options) {
    calls.push({ method, content, ...(options ? { options } : {}) });
    messages.push(content);
    onMessage(content);
  }
  const dependencies = {
    67120: { Message: { error: content => record("message.error", content) } },
    80713: { Toast: { show: options => record("toast", options.content, options) } },
    8655: { fmtMsg: (_key, fallback) => fallback }
  };
  function load(name) {
    const factory = vm.runInNewContext(`(${readFileSync(new URL(`${name}.js`, fixture), "utf8")})`);
    const exports = {};
    factory({ exports }, exports, id => {
      if (!dependencies[id]) throw new Error(`Unexpected native notification dependency ${id}`);
      return dependencies[id];
    });
    return exports.default.body;
  }
  return { MKXFORM: { platform, message: load("message"), toast: load("toast") }, messages, calls };
}
