/** Fixed executor CSS only. A native container survives layout save without a field UUID. */
export function nativeStylesheet(key, css) {
  return {
    key, type: "div", kind: "container",
    controlProps: { id: key, dangerouslySetInnerHTML: { __html: `<style>${css}</style>` } }
  };
}

export function nativeStylesheetCss(node) {
  if (node?.type !== "div" || node.kind !== "container" || typeof node.key !== "string" ||
      !node.controlProps || typeof node.controlProps !== "object" || Array.isArray(node.controlProps) || node.children !== undefined ||
      node.controlProps?.id !== node.key ||
      Object.keys(node.controlProps || {}).some(key => !["id", "dangerouslySetInnerHTML"].includes(key))) return undefined;
  const html = node.controlProps.dangerouslySetInnerHTML;
  if (!html || Object.keys(html).length !== 1 || typeof html.__html !== "string") return undefined;
  const match = /^<style>([\s\S]*)<\/style>$/.exec(html.__html);
  return match && !match[1].includes("<") ? match[1] : undefined;
}
