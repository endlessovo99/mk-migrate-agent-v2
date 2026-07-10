import { it } from "node:test";

export const localCorpusIt = process.env.MK_LOCAL_CORPUS_TESTS === "1"
  ? it
  : () => {};
