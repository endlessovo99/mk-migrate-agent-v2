export function detailTableNameFor(mainTableName, fieldId) {
  const maxLength = 30;
  const sourceMainTableName = String(mainTableName || "mk_model_main");
  const normalizedMainTableName = sourceMainTableName
    .replace(/[^a-zA-Z0-9_]+/g, "_");
  const suffixSeed = `${sourceMainTableName}:${String(fieldId || "detail")}`;
  const suffix = `_d_${stableHexId(suffixSeed).slice(0, 8)}`;
  const base = normalizedMainTableName.slice(0, maxLength - suffix.length);
  return `${base}${suffix}`;
}

function stableHexId(value) {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (const char of String(value)) {
    const code = char.charCodeAt(0);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code + 0x9e37;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }

  let output = "";
  while (output.length < 32) {
    h1 = Math.imul(h1 ^ (h1 >>> 13), 0x5bd1e995) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 15), 0x27d4eb2d) >>> 0;
    output += h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }
  return output.slice(0, 32);
}
