import { parse } from "acorn";

// Mask only parser-identified comments. On uncertain syntax, retain every byte
// of source evidence rather than applying a partial or regex-based deletion.
export function maskJavaScriptComments(source = "") {
  const text = String(source ?? "");
  const comments = [];
  try {
    parse(text, {
      ecmaVersion: "latest",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      onComment: (_block, _comment, start, end) => comments.push({ start, end })
    });
  } catch {
    return text;
  }
  const parts = [];
  let cursor = 0;
  for (const { start, end } of comments) {
    parts.push(text.slice(cursor, start), text.slice(start, end).replace(/[^\r\n]/g, " "));
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}
