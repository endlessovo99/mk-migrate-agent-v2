export function nativeMain(root) {
  if (root?.key === "main" && root.type === "main") return root;
  return (root?.children || []).map(nativeMain).find(Boolean);
}
