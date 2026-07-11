/**
 * Shared condition-branch default-route selection for writer and expected invariants.
 *
 * Priority:
 * 1. explicit isDefault
 * 2. edge name exactly "其他"
 * 3. tautology (1==1 / true) only when the branch has no named "其他" edge
 */
export function selectDefaultBranchEdge(edges = []) {
  const list = Array.isArray(edges) ? edges : [];
  const explicit = list.find(isExplicitDefaultEdge);
  if (explicit) return explicit;

  const namedOther = list.find(isNamedOtherEdge);
  if (namedOther) return namedOther;

  return list.find((edge) => isTautologyCondition(edgeConditionText(edge)));
}

export function isNamedOtherEdge(edge) {
  return String(edge?.name || "").trim() === "其他";
}

export function isExplicitDefaultEdge(edge) {
  return [true, "true", 1, "1"].includes(edge?.isDefault) ||
    [true, "true", 1, "1"].includes(edge?.attributes?.isDefault);
}

export function isTautologyCondition(condition) {
  return /^(?:1\s*={2,3}\s*1|true)$/i.test(String(condition || "").trim());
}

export function edgeConditionText(edge) {
  if (edge?.condition && typeof edge.condition === "object") {
    return edge.condition.targetText || edge.condition.sourceText || edge.condition.displayText || "";
  }
  return edge?.condition || edge?.displayCondition || "";
}
