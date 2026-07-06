import { cleanSourceFile } from "./source-draft.js";
import { draftSourceDraft } from "./dsl-draft.js";

export { cleanSourceFile } from "./source-draft.js";
export { draftSourceDraft } from "./dsl-draft.js";

export function translateSourceFile(path, options = {}) {
  return draftSourceDraft(cleanSourceFile(path, options), options);
}
