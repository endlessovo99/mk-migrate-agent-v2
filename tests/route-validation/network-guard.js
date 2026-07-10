import { integrityError } from "./integrity.js";

export async function withNetworkGuard(callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const attempts = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async () => {
      attempts.push({ transport: "fetch" });
      throw integrityError("route.network_attempt", "Network access is forbidden in Route-validation tests.");
    }
  });

  let result;
  let callbackError;
  try {
    result = await callback();
  } catch (error) {
    callbackError = error;
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "fetch", descriptor);
    else delete globalThis.fetch;
  }

  if (attempts.length) {
    throw integrityError("route.network_attempt", "Route-validation attempted network access.", {
      attempts: attempts.length
    });
  }
  if (callbackError) throw callbackError;
  return result;
}
