/** Ordered contents of one cell, with explicit line boundaries and item sizes. */
export function selectContentFlow(flow, referenceIds) {
  if (!flow) return undefined;
  const wanted = new Set(referenceIds);
  const lines = (flow.lines || []).map((line) => line.filter((id) => wanted.has(id)));
  const included = new Set(lines.flat());
  if (referenceIds.some((id) => !included.has(id))) return undefined;
  const items = (flow.items || []).filter((item) => wanted.has(item.referenceId));
  return { lines, items };
}

export function remapContentFlow(flow, mapId) {
  if (!flow) return undefined;
  return {
    lines: flow.lines.map((line) => line.map(mapId)),
    items: flow.items.map((item) => ({ ...item, referenceId: mapId(item.referenceId) }))
  };
}

/** A merged control occupies its first visible companion's original position. */
export function mergeContentFlowReferences(flow, replacements) {
  if (!flow || !replacements?.size) return flow;
  const mapId = (id) => replacements.get(id) || id;
  const replacedTargets = new Set(flow.lines.flat().filter((id) => replacements.has(id)).map(mapId));
  const seen = new Set();
  const lines = flow.lines.map((line) => line.flatMap((id) => {
    if (replacedTargets.has(id) && !replacements.has(id)) return [];
    const mapped = mapId(id);
    if (seen.has(mapped)) return [];
    seen.add(mapped);
    return [mapped];
  }));
  const items = new Map();
  for (const item of flow.items) {
    if (replacedTargets.has(item.referenceId) && !replacements.has(item.referenceId)) continue;
    const referenceId = mapId(item.referenceId);
    if (!items.has(referenceId) || replacements.has(item.referenceId)) {
      items.set(referenceId, { ...item, referenceId });
    }
  }
  return { lines, items: lines.flat().map((id) => items.get(id)) };
}

export function contentFlowIssues(flow, referenceIds) {
  if (!flow || typeof flow !== "object" || Array.isArray(flow)) return ["contentFlow must be an object"];
  const issues = [];
  if (Object.keys(flow).some((key) => !["lines", "items"].includes(key))) {
    issues.push("contentFlow contains an unsupported property");
  }
  const validLines = Array.isArray(flow.lines) && flow.lines.length > 0 &&
    flow.lines.every((line) => Array.isArray(line) && line.every((id) => typeof id === "string" && id.length > 0));
  if (!validLines) issues.push("lines must contain ordered arrays of field references");
  else if (JSON.stringify(flow.lines.flat()) !== JSON.stringify(referenceIds)) {
    issues.push("lines must contain each cell reference exactly once in cell order");
  }
  if (!Array.isArray(flow.items)) return [...issues, "items must be an array"];
  if (JSON.stringify(flow.items.map((item) => item?.referenceId)) !== JSON.stringify(referenceIds)) {
    issues.push("items must contain each cell reference exactly once in cell order");
  }
  for (const item of flow.items) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).some((key) => !["referenceId", "width"].includes(key))) {
      issues.push("contentFlow item is invalid");
      continue;
    }
    if (item.width === undefined) continue;
    if (!item.width || typeof item.width !== "object" || Array.isArray(item.width) ||
      Object.keys(item.width).some((key) => !["value", "unit"].includes(key)) ||
      !Number.isFinite(item.width.value) || item.width.value < 0 ||
      !["px", "%"].includes(item.width.unit)) {
      issues.push("item width must be a non-negative finite px or percentage size");
    }
  }
  return issues;
}
