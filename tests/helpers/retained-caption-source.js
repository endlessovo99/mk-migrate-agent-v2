import { cleanSourceFile } from "../../src/translator/index.js";

/**
 * Simulate a retained SourceDraft saved before staticCaptionFact existed.
 * This is a test compatibility boundary, not a production translator option:
 * keep every earlier source fact and width unchanged, removing only the newly
 * introduced authority to fold a standalone caption into a native title.
 */
export function cleanSourceWithoutCaptionFact(path, options) {
  const source = cleanSourceFile(path, options);
  return withoutCaptionRelations(source);
}

export function withoutCaptionRelations(source) {
  delete source.form.captionRelations;
  const fields = [
    ...(source.form?.controls || []),
    ...(source.form?.dataFields || []),
    ...(source.form?.detailTables || []).flatMap(table => table.columns || [])
  ];
  for (const field of fields) {
    if (field.sourceProps) {
      delete field.sourceProps.staticCaptionFact;
      delete field.sourceProps.captionStructure;
    }
  }
  return source;
}
