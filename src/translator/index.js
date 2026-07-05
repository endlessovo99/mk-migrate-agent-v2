import { readFileSync } from "node:fs";
import { translateNewSource } from "./new-source-adapter.js";

export function translateSourceFile(path) {
  const source = readJson(path);
  return translateNewSource(source, { sourcePath: path });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to read source JSON at ${path}: ${error.message}`);
  }
}
