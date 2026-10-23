/** Render a source-derived alert using the documented API for each platform. */
export function nativeValidationMessage(messageExpression, indent = "") {
  return [
    `${indent}if (MKXFORM.platform === "mobile") {`,
    `${indent}  MKXFORM.toast({ content: ${messageExpression}, icon: "fail" });`,
    `${indent}} else {`,
    `${indent}  MKXFORM.message.error(${messageExpression});`,
    `${indent}}`
  ].join("\n");
}
