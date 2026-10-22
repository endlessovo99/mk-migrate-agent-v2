import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { captionImpactReach } from "../../src/translator/caption-impact-reach.js";

/** Independent structural ledger. It does not import the caption merger.
 * Expectations come from source binding, layout adjacency and permission
 * wrappers. A caller may also supply a closed script-impact predicate. */
export function reviewCaptionRelations(source, pairImpact) {
  const fields = allFields(source);
  const reach = typeof pairImpact === "function"
    ? { bounded: true, anchors: [], selectors: [], rowMarkers: [] }
    : captionImpactReach(scriptTexts(source));
  const relations = [];
  for (const owner of fields) {
    if (owner.sourceType === "description" || owner.dataOnly || owner.sourceProps?.hardHidden) continue;
    const captionIds = captionIdsFor(source, owner, fields);
    if (!captionIds.length) continue;
    relations.push(expectRelation(source, fields, owner, captionIds, reach, pairImpact));
  }
  return relations;
}

export function reviewCaptionLedger(source, inputs, pairImpact) {
  return { inputs, relations: reviewCaptionRelations(source, pairImpact) };
}

export function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function expectRelation(source, fields, owner, captionIds, reach, pairImpact) {
  const captions = captionIds.map(id => fields.find(field => field.id === id)).filter(Boolean);
  const caption = captions[0];
  const title = String(caption?.title || caption?.sourceProps?.designerValues?.content || "").trim();
  const base = { fieldId: owner.id, sourceRef: owner.sourceRef, captionIds, title: title || owner.title || owner.id };
  const left = cells(source, caption?.id), right = cells(source, owner.id);
  const users = fields.filter(field => field.id !== caption?.id && (field.id === owner.id || captionIds.some(id => {
    if (field.sourceProps?.layoutCell?.captionIds?.includes(id)) return true;
    if (field.sourceProps?.designerValues?._label_bind_id !== id) return false;
    // A stale exported pointer with the bind flag off, outside the rendered
    // value cell, is not a second owner.
    return String(field.sourceProps?.designerValues?._label_bind).toLowerCase() === "true" ||
      right.some(item => item.cell.references?.some(ref => ref.referenceId === field.id));
  })));
  const values = caption?.sourceProps?.designerValues || {};
  const samePermission = (caption?.sourceProps?.rightContainer?.id || "") === (owner.sourceProps?.rightContainer?.id || "");
  const evidence = { bindingFlag: owner.sourceProps?.designerValues?._label_bind ?? null,
    captionCell: left[0]?.cell?.sourceRef || null, fieldCell: right[0]?.cell?.sourceRef || null,
    permission: samePermission ? (owner.sourceProps?.rightContainer ? "same-wrapper" : "unwrapped") : "different-wrapper" };
  const exception = (reason, basis) => ({ ...base, expectation: "exception", basis, evidence: { ...evidence, reason } });
  const unfinished = (reason, basis) => ({ ...base, expectation: "needs-evidence", basis, evidence: { ...evidence, reason, ...(reach.bounded ? {} : { boundary: reach.reason }) } });
  if (captionIds.length !== 1 || captions.length !== 1) return unfinished("caption_identity_ambiguous", "多个标题标识没有唯一的源控件");
  if (owner.sourceProps?.layoutCell?.relation === "standard-table-column-header" || owner.sourceProps?.detailHeaderCaption)
    return exception("column_header", "源表把该文字作为列头，而不是这一个输入控件的标题");
  if (users.length !== 1 || right[0]?.cell?.references?.length > 1) return exception("shared_caption", "同一个标题对应多个控件，或值单元格里不只有一个控件");
  if (!samePermission || independentWorkflow(source.workflow, caption.id, owner.id))
    return exception("independent_permission", "标题和控件不在同一个权限包装里，或节点可见性不一致");
  if (caption.sourceProps?.metadataId) return exception("caption_has_data_identity", "标题本身带有数据身份，不能并进控件");
  if (!title || /[<>]/.test(title) || ["font", "color", "effect"].some(key => values[key]))
    return unfinished("caption_formatting_or_text", "标题文字不是单一纯文本，或带有颜色、字体或特效");
  if (left.length !== 1 || right.length !== 1 || left[0].row !== right[0].row ||
      left[0].cell.references?.length !== 1 || right[0].cell.references?.length !== 1 ||
      (left[0].cell.rowspan || 1) !== 1 || (right[0].cell.rowspan || 1) !== 1 ||
      left[0].cell.column + left[0].cell.colspan !== right[0].cell.column ||
      !singleFlow(left[0].cell, true) || !singleFlow(right[0].cell))
    return unfinished("compound_region", "标题和控件没有占据同一行里两个相邻的单控件单元格");
  const fact = caption.sourceProps?.staticCaptionFact;
  const legacyRendered = fact && (fact.runtimePresent !== true && String(owner.sourceProps?.designerValues?._label_bind).toLowerCase() === "true" ||
    fact.runtimeOwnerId === owner.id ||
    ["runtime-independent-title-cell", "retained-source-caption"].includes(owner.sourceProps?.layoutCell?.relation)) &&
    !fact.runtimeHiddenOwnerIds?.includes(owner.id);
  const issue = caption.sourceProps?.captionStructureIssue?.reason;
  const fromAdjacent = !owner.sourceProps?.layoutCell?.captionIds?.length &&
    String(owner.sourceProps?.designerValues?._label_bind).toLowerCase() !== "true";
  const layoutMayOwn = fromAdjacent && String(caption.title || "").replace(/\s+/g, "") === String(owner.title || "").replace(/\s+/g, "") &&
    (!issue || ["source_binding_or_ancestry_unproven", "value_cell_has_multiple_or_missing_editors"].includes(issue));
  const structure = caption.sourceProps?.captionStructure || (legacyRendered ? fact : undefined) ||
    (layoutMayOwn && fact?.plainText !== false && fact?.unique !== false && fact?.unguarded !== false
      ? { ownerId: owner.id, plainText: true, unique: true, unguarded: true } : undefined);
  if (!structure || (structure.ownerId && structure.ownerId !== owner.id) || structure.plainText !== true || structure.unique !== true || structure.unguarded !== true)
    return unfinished(caption.sourceProps?.captionStructureIssue?.reason || "caption_structure_unproven", "源绑定、相邻布局和实际渲染控件还没有同时证明这一对标题");
  if (typeof pairImpact === "function") {
    const impact = pairImpact(owner.id, caption.id, caption.sourceProps?.captionStructure?.domContext || caption.sourceProps?.staticCaptionFact?.domContext);
    if (!impact?.ok) return unfinished(impact?.issue?.reason || "script_impact", scriptBasis(impact));
  } else if (!reach.bounded) return unfinished(reach.reason || "script_unbounded", "脚本影响范围不能限定到具体控件，普通标题仍不能合并");
  if (typeof pairImpact !== "function") {
  const rowIds = [];
  for (const marker of reach.rowMarkers || []) {
    const ids = rowFieldIds(source, marker);
    if (!ids) return unfinished("row_region_unproven", `脚本操作的行 ${marker} 无法对应到完整的源布局区域`);
    rowIds.push(ids);
  }
  if (rowIds.some(ids => ids.includes(owner.id) !== ids.includes(caption.id)))
    return unfinished("row_region_separates_title_and_value", "脚本按行操作时，标题和控件不在同一行");
  const hit = [owner.id, caption.id].filter(id => reach.anchors.includes(id));
  if (hit.length) return unfinished("local_script_reach", `脚本明确作用在 ${hit.join(", ")}，这个标题不能并进控件`);
  }
  const emphasis = ["b", "i", "underline"].filter(key => values[key] === "true");
  return { ...base, expectation: "merge", basis: emphasis.length
    ? "一对一绑定、相邻单元格和同一权限包装成立；粗体/斜体/下划线只是标题强调"
    : "一对一绑定、相邻单元格、实际渲染控件和同一权限包装一致",
    evidence: { ...evidence, ...(emphasis.length ? { titleEmphasis: emphasis } : {}),
      ...(reach.selectors?.length ? { selectors: reach.selectors } : {}) } };
}

function scriptBasis(impact) {
  const issue = impact?.issue || {};
  if (issue.impact === "fixed-source-region") return "脚本明确作用在这一对控件或它所在区域，标题需要保持独立";
  return `脚本影响范围不能限定到具体控件（${issue.boundary || issue.reason || "unbounded"}）`;
}

function captionIdsFor(source, owner, fields) {
  const existing = owner.sourceProps?.layoutCell?.captionIds;
  if (existing?.length) return [...existing];
  const adjacent = adjacentCaption(source, owner, fields);
  const bindOn = String(owner.sourceProps?.designerValues?._label_bind).toLowerCase() === "true";
  if (adjacent && !bindOn) return [adjacent];
  const id = owner.sourceProps?.designerValues?._label_bind_id;
  const caption = fields.find(field => field.id === id && field.sourceType === "description" && !field.dataOnly && !field.sourceProps?.hardHidden);
  if (caption) return [id];
  return adjacent ? [adjacent] : [];
}

function adjacentCaption(source, owner, fields) {
  const text = String(owner.title || "").replace(/\s+/g, "");
  if (!text || owner.sourceType === "description") return undefined;
  for (const row of source.form?.layout?.rows || []) {
    const cells = row.cells || [];
    const index = cells.findIndex(cell => cell.references?.length === 1 && cell.references[0].referenceId === owner.id);
    if (index <= 0) continue;
    const left = cells[index - 1], right = cells[index];
    if (left.references?.length !== 1 || (left.rowspan || 1) !== 1 || (right.rowspan || 1) !== 1) continue;
    if (!Number.isInteger(left.column) || !Number.isInteger(left.colspan) || left.column + left.colspan !== right.column) continue;
    const caption = fields.find(field => field.id === left.references[0].referenceId && field.sourceType === "description");
    if (!caption || String(caption.title || "").replace(/\s+/g, "") !== text) continue;
    if (fields.some(field => field.id !== owner.id && field.sourceProps?.layoutCell?.captionIds?.includes(caption.id))) continue;
    return caption.id;
  }
  return undefined;
}

function allFields(source) {
  return [...(source.form?.controls || []), ...(source.form?.dataFields || []),
    ...(source.form?.detailTables || []).flatMap(table => [table, ...(table.columns || [])])];
}

function rowFieldIds(source, marker) {
  const rows = (source.form?.layout?.rows || []).filter(row => row.sourceMarkers?.includes(marker));
  if (!rows.length) return undefined;
  return [...new Set(rows.flatMap(row => (row.cells || []).flatMap(cell => (cell.references || []).map(ref => ref.referenceId))))];
}

function cells(source, id) {
  if (!id) return [];
  return (source.form?.layout?.rows || []).flatMap(row => (row.cells || [])
    .filter(cell => cell.references?.some(ref => ref.referenceId === id)).map(cell => ({ row, cell })));
}

function singleFlow(cell, allowEmptyTail = false) {
  const flow = cell.contentFlow;
  return !flow || flow.lines?.[0]?.length === 1 &&
    (flow.lines.length === 1 || allowEmptyTail && flow.lines.length === 2 && flow.lines[1]?.length === 0 &&
      flow.items?.length === 1 && flow.items[0].referenceId === flow.lines[0][0]);
}

function independentWorkflow(workflow, captionId, ownerId) {
  return (workflow?.nodes || []).some(node => {
    const caption = node.dataAuthority?.fields?.[captionId], owner = node.dataAuthority?.fields?.[ownerId];
    return caption && (!owner || caption.visible !== owner.visible || caption.sourceMode !== owner.sourceMode);
  });
}

function scriptTexts(source) {
  const texts = [];
  for (const item of source.scripts?.sources || []) {
    if (typeof item.javascript === "string") texts.push(item.javascript);
    if (typeof item.helperJavascript === "string") texts.push(item.helperJavascript);
  }
  for (const field of allFields(source)) {
    for (const [key, value] of Object.entries(field.sourceProps?.designerValues || {})) {
      if (/^(?:on|script|function|event)/i.test(key) && typeof value === "string") texts.push(value);
    }
    for (const fact of [field.sourceProps?.captionStructure, field.sourceProps?.staticCaptionFact]) {
      for (const script of fact?.domContext?.inlineScripts || []) texts.push(script);
    }
  }
  return [...new Set(texts)];
}
