import { mergeContentFlowReferences } from '../dsl/content-flow.js';

/** Fold a name-only display into its native address control, never an independent input. */
export function foldRedundantAddressCompanions(form, source) {
  const fields = form.fields || [];
  const replacements = new Map();
  const contexts = fields.flatMap(field => [field.sourceProps?.staticCaptionFact?.domContext,
    field.sourceProps?.captionStructure?.domContext]).filter(Boolean);
  const external = JSON.stringify([source.scripts, source.workflow, source.formRules,
    contexts.flatMap(context => context.inlineScripts || [])]);
  const incompleteRuntime = contexts.some(context => context.inlineDomainComplete === false);
  const label = value => String(value || '').trim();
  for (const address of fields) {
    const id = address.sourceProps?.addressDisplayCompanionId;
    const input = fields.find(field => field.id === id);
    const av = address.sourceProps?.designerValues || {};
    const iv = input?.sourceProps?.designerValues || {};
    if (!input || address.componentId !== 'xform-address' || input.componentId !== 'xform-input') continue;
    // Legacy display/selector pairs may have explicit selection labels or numbered
    // applicant labels. The latter also require actual xtext/caption evidence.
    const sharedBinding = iv._label_bind_id && iv._label_bind_id === av._label_bind_id;
    const selectionLabel = iv._label_bind === 'true' && label(iv.label) &&
      label(av.label) === label(iv.label) + '选择' &&
      input.sourceProps?.boundCaption?.id === iv._label_bind_id &&
      label(input.sourceProps?.boundCaption?.content) === label(iv.label);
    const numberedApplicant = label(iv.label) === '申请人1' && label(av.label) === '申请人2' &&
      input.sourceProps?.layoutCell?.renderer === 'xform:xtext' &&
      input.sourceProps?.layoutCell?.relation === 'retained-source-caption' &&
      input.sourceProps.layoutCell.captionIds?.length > 0 &&
      JSON.stringify(input.sourceProps.layoutCell.captionIds) ===
        JSON.stringify(address.sourceProps?.layoutCell?.captionIds);
    if (Number(av.width) !== 0 || !sharedBinding || (!selectionLabel && !numberedApplicant)) continue;
    if (iv.readOnly === 'true' || iv.canShow === 'false' ||
        label(iv.formula) || label(iv.defaultValue) || label(input.sourceProps?.metadataAttributes?.defaultValue) ||
        incompleteRuntime || external.includes(id) ||
        fields.some(field => field !== input && field !== address && semanticReferences(field).includes(id))) continue;
    replacements.set(id, address.id);
  }
  if (!replacements.size) return form;
  return {
    ...form,
    fields: fields.filter(field => !replacements.has(field.id)).map(field => {
      const id = field.sourceProps?.addressDisplayCompanionId;
      if (!replacements.has(id)) return field;
      const input = fields.find(candidate => candidate.id === id);
      return { ...field, props: { ...field.props, ...(input.props?.required ? { required: true } : {}) },
        sourceProps: { ...field.sourceProps, consumedAddressDisplayCompanionId: id } };
    }),
    layout: { ...form.layout, mkTree: (form.layout?.mkTree || []).map(row => ({
      ...row, children: (row.children || []).map(cell => {
        if (cell.refType !== 'field') return cell;
        const refIds = [...new Set(cell.refIds.map(id => replacements.get(id) || id))];
        return { ...cell, refIds, ...(cell.contentFlow ? { contentFlow: mergeContentFlowReferences(cell.contentFlow, replacements) } : {}) };
      })
    })) }
  };
}

function semanticReferences(field) {
  // Observational evidence inventories DOM identities and scripts; it
  // is not another control's executable/value dependency on this companion.
  const { staticCaptionFact, staticCaptionIssue, captionStructure, captionStructureIssue, ...sourceProps } = field.sourceProps || {};
  if (sourceProps.radioReadOnlySourceFact?.version === 1 &&
      sourceProps.radioReadOnlySourceFact.kind === 'static-main-radio-group') {
    delete sourceProps.radioReadOnlySourceFact;
  }
  return JSON.stringify({ ...field, sourceProps });
}
