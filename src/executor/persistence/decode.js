import { diagnostic } from "./diagnostics.js";

export function decodeRequiredJsonObject(value, {
  partition,
  decodePath,
  code = `readback.decode.${partition}.invalid_json`
}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, value };
  }
  if (value === undefined || value === null || value === "") {
    return {
      ok: false,
      diagnostic: diagnostic({
        level: "error",
        code: `readback.decode.${partition}.missing`,
        message: `Required native ${partition} structure is missing.`,
        partition,
        decodePath,
        path: decodePath
      })
    };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      diagnostic: diagnostic({
        level: "error",
        code: `readback.decode.${partition}.wrong_type`,
        message: `Required native ${partition} structure has the wrong type.`,
        partition,
        decodePath,
        path: decodePath,
        actual: typeName(value)
      })
    };
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        diagnostic: diagnostic({
          level: "error",
          code,
          message: `Required native ${partition} JSON must decode to an object.`,
          partition,
          decodePath,
          path: decodePath,
          actual: typeName(parsed)
        })
      };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return {
      ok: false,
      diagnostic: diagnostic({
        level: "error",
        code,
        message: `Required native ${partition} JSON is malformed.`,
        partition,
        decodePath,
        path: decodePath,
        details: { reason: error instanceof Error ? error.message : String(error) }
      })
    };
  }
}

export function requireArray(value, { partition, decodePath, code }) {
  if (Array.isArray(value)) return { ok: true, value };
  return {
    ok: false,
    diagnostic: diagnostic({
      level: "error",
      code: code || `readback.decode.${partition}.array_required`,
      message: `Required native ${partition} array is missing or wrong-typed.`,
      partition,
      decodePath,
      path: decodePath,
      actual: typeName(value)
    })
  };
}

export function requireRecord(value, { partition, decodePath, code }) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, value };
  }
  return {
    ok: false,
    diagnostic: diagnostic({
      level: "error",
      code: code || `readback.decode.${partition}.object_required`,
      message: `Required native ${partition} object is missing or wrong-typed.`,
      partition,
      decodePath,
      path: decodePath,
      actual: typeName(value)
    })
  };
}

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
