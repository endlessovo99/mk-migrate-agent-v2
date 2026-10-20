import { draftSourceDraft as draftCurrentSource } from "../../src/translator/index.js";

/**
 * Exercise the retained source-sized DSL contract explicitly. These regression
 * tests preserve the original width assertions while new drafts default to
 * adaptive sizing; source evidence and all other mapper options stay intact.
 */
export function draftSourceDraft(source, options = {}) {
  return draftCurrentSource(source, { ...options, layoutSizing: "source" });
}
