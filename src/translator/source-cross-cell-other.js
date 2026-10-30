import { cleanText } from "./xml-utils.js";
import { inspectCrossCellOtherContexts } from "./static-caption-facts.js";

/** Recognize a plain, explicitly bound Other caption beside its source checkbox. */
export function annotateCrossCellOther(form, designerHtml, runtimeHtml) {
  const fields = form?.fields || [], byId = id => fields.filter(field => field.id === id), candidates = [];
  for (const row of form?.layout?.rows || []) {
    const cells = row.cells || [];
    for (let index = 0; index + 2 < cells.length; index++) {
      const group = cells.slice(index, index + 3);
      if (group.some(cell => cell.colspan !== 1 || cell.fieldIds?.length !== 1) ||
          group[1].column !== group[0].column + 1 || group[2].column !== group[1].column + 1) continue;
      const matches = group.map(cell => byId(cell.fieldIds[0]));
      if (matches.some(items => items.length !== 1)) continue;
      const [choice, caption, text] = matches.map(items => items[0]);
      if (choice.type !== "checkbox" || choice.source?.otherTextCompanion || choice.source?.hardHidden === true || caption.type !== "description" || text.type !== "text" ||
          text.required === true || text.source?.hardHidden === true || String(text.source?.designerValues?.readOnly || "").toLowerCase() === "true" ||
          (choice.options || []).some(option => /^(?:\d+\s*[.．、)）]\s*)?(?:其他|其它)/u.test(cleanText(option.label || "")))) continue;
      const label = cleanText(caption.title || ""), match = /^(?:其他|其它)(.{2,})$/u.exec(label), subject = match?.[1];
      const structure = caption.source?.captionStructure;
      if (!subject || !cleanText(choice.title || "").endsWith(subject) || cleanText(text.title || "") !== label ||
          text.source?.boundCaption?.id !== caption.id || structure?.ownerId !== text.id || structure.plainText !== true ||
          structure.unique !== true || structure.unguarded !== true || structure.runtimeRenderer !== "xform:xtext" ||
          caption.source?.staticCaptionFact?.runtimePresent !== true) continue;
      candidates.push({ choiceId: choice.id, captionId: caption.id, textId: text.id, caption: label,
        rowId: row.id, choiceCellId: group[0].id, captionCellId: group[1].id, textCellId: group[2].id });
    }
  }
  const counts = id => candidates.filter(item => [item.choiceId, item.captionId, item.textId].includes(id)).length;
  const unique = candidates.filter(item => [item.choiceId, item.captionId, item.textId].every(id => counts(id) === 1));
  const contexts = inspectCrossCellOtherContexts(designerHtml, runtimeHtml, unique);
  for (const candidate of unique) {
    const context = contexts.get(candidate.choiceId), choice = byId(candidate.choiceId)[0];
    if (!context) continue;
    choice.source = { ...choice.source, otherPairContext: context, otherTextCompanion: {
      id: candidate.textId, captionId: candidate.captionId, caption: candidate.caption, otherRequired: false,
      crossCell: { version: 1, rowId: candidate.rowId, choiceCellId: candidate.choiceCellId,
        captionCellId: candidate.captionCellId, textCellId: candidate.textCellId }
    } };
  }
}
