import { componentSupportsProp } from "../dsl/catalogs.js";
import { captionScriptReferences } from "./caption-script-references.js";
import { captionScriptScope } from "./caption-script-scope.js";
import { hasSingleControlFlow } from "./source-caption-relations.js";

/**
 * A source caption may become an intrinsic title only when its identity,
 * ownership and complete occupied region are unambiguous. Source facts and the
 * source grid remain intact; only the target fields and render tree are folded.
 */
export function foldNativeCaptions(form, source, { decisions = [], behavior } = {}) {
  const originals = [
    ...(source.form?.controls || []), ...(source.form?.dataFields || []),
    ...(source.form?.detailTables || []).flatMap(table => [table, ...(table.columns || [])])
  ];
  const rows = source.form?.layout?.rows || [];
  const fields = form.fields || [];
  const protectedText = JSON.stringify({
    sources: source.scripts?.sources, fragments: source.scripts?.fragments,
    buttons: source.scripts?.buttons, formRules: source.formRules
  });
  const scripts = (source.scripts?.sources || []).flatMap(item =>
    [item.javascript, item.helperJavascript].filter(value => typeof value === "string"));
  scripts.push(...originals.flatMap(field => Object.entries(field.sourceProps?.designerValues || {})
    .filter(([key, value]) => /^(?:on|script|function|event)/i.test(key) && typeof value === "string")
    .map(([, value]) => value)));
  scripts.push(...new Set(originals.flatMap(field => field.sourceProps?.staticCaptionFact?.domContext?.inlineScripts || [])));
  const sourceReferences = captionScriptReferences(scripts);
  const scriptScope = !behavior && sourceReferences.opaque ? captionScriptScope(scripts, form, originals) : undefined;
  const folded = new Map();
  const consumed = new Set();
  const tree = structuredClone(form.layout?.mkTree || []);

  for (const field of fields) {
    const original = originals.filter(item => item.id === field.id);
    const relationFact = source.form?.captionRelations?.find(item => item.fieldId === field.id && item.sourceRef === field.sourceRef);
    const captionIds = relationFact?.captionIds || field.sourceProps?.layoutCell?.captionIds || [];
    if (!captionIds.length) continue;
    const record = (status, reason, evidence) => decisions.push({
      fieldId: field.id, sourceRef: field.sourceRef, title: field.title, captionIds, status, reason, ...(evidence ? { evidence } : {})
    });
    if (original.length !== 1) { record("unproven", "identity_ambiguous"); continue; }
    if (relationFact && relationFact.disposition !== "field-caption") {
      record(relationFact.disposition === "exception" ? "preserved" : "unproven", relationFact.reason, relationFact.evidence);
      continue;
    }
    if (!eligibleOwner(field, relationFact)) {
      record("preserved", field.sourceProps?.rightContainer ? "independent_permission" : "owner_presentation_protected");
      continue;
    }
    const owner = original[0];
    const captionId = captionIds.length === 1 ? captionIds[0] : undefined;
    const candidates = originals.filter(item => item.id === captionId);
    if (!captionId || candidates.length !== 1 || consumed.has(captionId)) {
      record("unproven", "caption_identity_ambiguous"); continue;
    }
    const caption = candidates[0], targetCaption = fields.filter(item => item.id === captionId);
    const users = originals.filter(item => item.sourceProps?.designerValues?._label_bind_id === captionId ||
      item.sourceProps?.layoutCell?.captionIds?.includes(captionId));
    if (!relationFact && (users.length !== 1 || users[0].id !== owner.id)) { record("preserved", "shared_caption"); continue; }
    if ((!relationFact && caption.sourceProps?.rightContainer) || caption.sourceProps?.metadataId) {
      record("preserved", "independent_permission_or_data"); continue;
    }
    const fact = relationFact && caption.sourceProps?.captionStructure || caption.sourceProps?.staticCaptionFact;
    if (fact?.plainText !== true || fact.unique !== true || fact.unguarded !== true || fact.content !== caption.title) {
      record("unproven", "static_caption_unproven", caption.sourceProps?.staticCaptionIssue); continue;
    }
    if (targetCaption.length !== 1 ||
        targetCaption[0].componentId !== "xform-description" ||
        targetCaption[0].dataOnly || targetCaption[0].props?.style) {
      record("preserved", "caption_presentation_protected"); continue;
    }
    const title = String(targetCaption[0].props?.content || "").trim();
    if (!title || /[<>\r\n]/.test(title) || title !== String(caption.title).trim()) {
      record("unproven", "caption_content_mismatch"); continue;
    }
    if (!relationFact && !ownsCaption(owner, caption)) { record("unproven", "ownership_unproven"); continue; }
    if (fact.domContext?.inlineDomainComplete === false) {
      record("unproven", "dynamic_script_unproven", { reason: "runtime_attributes_unproven" }); continue;
    }
    if (protectedText.includes(captionId) ||
        workflowReferencesCaption(source.workflow, captionId, owner.id, relationFact) ||
        sourceReferences.values.some(value => value.includes(captionId)) ||
        referencedByField(originals, captionId)) { record("preserved", "source_reference"); continue; }
    const impact = behavior?.forPair(owner.id, captionId, fact.domContext);
    if (impact && !impact.ok) {
      record(impact.bounded ? "preserved" : "unproven", impact.bounded ? "scoped_script_dependency" : "dynamic_script_unproven", impact.issue);
      continue;
    }
    if (!impact && sourceReferences.opaque && !scriptScope?.ok) {
      record("unproven", "dynamic_script_unproven", scriptScope?.issue); continue;
    }
    if (!impact && sourceReferences.opaque && fact.domContext?.version !== 1) {
      record("unproven", "script_region_unproven"); continue;
    }
    if (!impact && scriptScope?.targets.some(id => [owner.id, captionId, ...(fact.domContext?.ancestorIds || [])].includes(id))) {
      record("preserved", "scoped_script_dependency"); continue;
    }
    if (!impact && scriptScope?.parentReads?.length && !fact.domContext) {
      record("unproven", "script_region_unproven"); continue;
    }
    if (!impact && scriptScope?.parentReads?.some(id => fact.domContext.cellDescendantIds.includes(id))) {
      record("preserved", "scoped_script_dependency"); continue;
    }
    const left = sourceCell(rows, captionId), right = sourceCell(rows, owner.id);
    const allowEmptyTail = relationFact?.evidence?.captionTrailingEmptyLine === true;
    if (!adjacentPair(left, right, allowEmptyTail)) { record("unproven", "source_region_unproven"); continue; }
    const leftTarget = targetCell(tree, captionId), rightTarget = targetCell(tree, field.id);
    if (!adjacentPair(leftTarget, rightTarget, allowEmptyTail)) { record("unproven", "target_region_unproven"); continue; }
    // Flattened/nested projections may represent a different region. They do
    // not inherit authority from adjacency in the target tree alone.
    if (leftTarget.cell.sourceRef !== left.cell.sourceRef ||
        rightTarget.cell.sourceRef !== right.cell.sourceRef) { record("unproven", "region_identity_mismatch"); continue; }
    const cell = rightTarget.cell;
    cell.column = leftTarget.cell.column;
    cell.colspan += leftTarget.cell.colspan;
    if (Number.isFinite(leftTarget.cell.widthWeight) && Number.isFinite(cell.widthWeight)) {
      cell.widthWeight += leftTarget.cell.widthWeight;
    } else {
      delete cell.widthWeight;
    }
    rightTarget.row.children = rightTarget.row.children.filter(item => item !== leftTarget.cell);
    const { hiddenLabel: _hidden, ...props } = field.props || {};
    folded.set(field.id, {
      ...field, title, props,
      sourceProps: {
        ...field.sourceProps,
        foldedCaption: {
          id: captionId, sourceRef: caption.sourceRef, content: title,
          captionCellSourceRef: left.cell.sourceRef, fieldCellSourceRef: right.cell.sourceRef,
          ...(relationFact ? { referenceMap: { sourceLabelId: captionId, fieldId: field.id, part: "title",
            formerControlId: captionId, sourceRowRef: left.row.sourceRef }, behavior: impact?.evidence } : {})
        }
      }
    });
    consumed.add(captionId);
    record("folded", "unique_plain_caption");
  }
  if (!folded.size) return form;
  return {
    ...form,
    fields: fields.filter(field => !consumed.has(field.id)).map(field => folded.get(field.id) || field),
    layout: { ...form.layout, mkTree: tree }
  };
}

function eligibleOwner(field, relationFact) {
  const facts = field.sourceProps || {};
  return !field.dataOnly && !facts.hardHidden && (!facts.rightContainer || relationFact?.disposition === "field-caption") &&
    !facts.inlineCaption && !facts.explicitTitle && !facts.detailHeaderCaption &&
    field.type !== "detailTable" && field.type !== "description" &&
    componentSupportsProp(field.componentId, "hiddenLabel") &&
    (relationFact?.disposition === "field-caption" || field.props?.hiddenLabel === true &&
      ["independent-bound-title-cell", "runtime-independent-title-cell", "retained-source-caption"]
        .includes(facts.layoutCell?.relation));
}

function ownsCaption(owner, caption) {
  const facts = owner.sourceProps, values = facts.designerValues || {};
  if (facts.layoutCell.relation === "independent-bound-title-cell") {
    const fact = caption.sourceProps?.staticCaptionFact;
    return !fact?.runtimeHiddenOwnerIds?.includes(owner.id) &&
      (String(values._label_bind).toLowerCase() === "true" || fact?.runtimeOwnerId === owner.id) &&
      values._label_bind_id === caption.id &&
      facts.boundCaption?.relation === "explicit-label-bind-id" &&
      facts.boundCaption.id === caption.id;
  }
  if (facts.layoutCell.relation === "runtime-independent-title-cell") {
    return facts.layoutCell.evidence?.captionId === caption.id &&
      facts.layoutCell.evidence.content === caption.title;
  }
  return facts.layoutCell.relation === "retained-source-caption" &&
    facts.layoutCell.sourceRef === "source.form.fdDisplayJsp";
}

function sourceCell(rows, id) {
  const matches = rows.flatMap(row => (row.cells || [])
    .filter(cell => cell.references?.some(ref => ref.referenceId === id))
    .map(cell => ({ row, cell, ids: cell.references.map(ref => ref.referenceId) })));
  return matches.length === 1 ? matches[0] : undefined;
}

function targetCell(rows, id) {
  const matches = rows.flatMap(row => (row.children || [])
    .filter(cell => cell.refIds?.includes(id))
    .map(cell => ({ row, cell, ids: cell.refIds })));
  return matches.length === 1 ? matches[0] : undefined;
}

function adjacentPair(left, right, allowEmptyTail = false) {
  if (!left || !right || left.row !== right.row || left.ids.length !== 1 || right.ids.length !== 1) return false;
  const a = left.cell, b = right.cell;
  return (a.row || 0) === (b.row || 0) && (a.rowspan || 1) === 1 && (b.rowspan || 1) === 1 &&
    Number.isInteger(a.column) && Number.isInteger(a.colspan) && Number.isInteger(b.colspan) &&
    a.colspan > 0 && b.colspan > 0 && a.column + a.colspan === b.column &&
    hasSingleControlFlow(a, allowEmptyTail) && hasSingleControlFlow(b);
}

function referencedByField(fields, id) {
  return fields.some(field => Object.entries(field.sourceProps?.designerValues || {})
    .some(([key, value]) => !["id", "label", "content", "_label_bind_id"].includes(key) &&
      typeof value === "string" && value.includes(id)));
}

function workflowReferencesCaption(workflow, captionId, fieldId, relation) {
  if (!workflow) return false;
  const copy = structuredClone(workflow);
  if (relation?.disposition === "field-caption") for (const node of copy.nodes || []) {
    const fields = node.dataAuthority?.fields;
    if (fields?.[captionId] && fields[fieldId] &&
        fields[captionId].visible === fields[fieldId].visible && fields[captionId].sourceMode === fields[fieldId].sourceMode) {
      delete fields[captionId];
    }
  }
  return JSON.stringify(copy).includes(captionId);
}

export function mapCaptionAuthorities(workflow, form) {
  if (!workflow) return workflow;
  const consumed = new Set((form.fields || []).flatMap(field => field.sourceProps?.foldedCaption
    ? [field.sourceProps.foldedCaption.id, field.sourceProps.foldedCaption.referenceMap?.formerControlId].filter(Boolean) : []));
  return { ...workflow, nodes: (workflow.nodes || []).map(node => {
    if (!node.dataAuthority?.fields) return node;
    return { ...node, dataAuthority: { ...node.dataAuthority, fields: Object.fromEntries(
      Object.entries(node.dataAuthority.fields).filter(([id]) => !consumed.has(id))) } };
  }) };
}
