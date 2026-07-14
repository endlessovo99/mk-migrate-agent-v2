import { isVoidLikeTag, scanHtmlTags } from "./designer-html-tokenizer.js";

export function applyAdjacentDetailTableTitles(controls, isSuspiciousTitle) {
  const consumedHeadingIds = new Set();
  let descriptionBlockStart = 0;
  const result = controls.map((control, index) => {
    if (control.type !== "detailTable") {
      if (control.type !== "description") descriptionBlockStart = index + 1;
      return control;
    }
    const headingCandidates = controls.slice(descriptionBlockStart, index)
      .filter((candidate) => isExplicitDetailTableHeading(candidate));
    descriptionBlockStart = index + 1;
    const heading = headingCandidates.length === 1 ? headingCandidates[0] : undefined;
    if (
      !heading ||
      !isSuspiciousTitle(control.title)
    ) return control;
    consumedHeadingIds.add(heading.id);
    return {
      ...control,
      title: heading.title,
      source: {
        ...control.source,
        explicitTitle: {
          sourceId: heading.id,
          content: heading.title,
          evidence: "preceding-large-bold-textLabel-in-same-cell"
        }
      }
    };
  });
  return result.filter((control) => !consumedHeadingIds.has(control.id));
}

export function attachmentContextControls(html, attachmentEntry, entries) {
  const ranges = enclosingElementRanges(html, attachmentEntry.start)
    .filter((range) => range.start !== attachmentEntry.start)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start));
  for (const range of ranges) {
    const contained = entries.filter((entry) =>
      entry.start >= range.start && entry.start < range.end
    );
    if (
      contained.some((entry) => entry.control.id === attachmentEntry.control.id) &&
      contained.some((entry) => isSourceDescription(entry.control))
    ) {
      return contained.map((entry) => entry.control);
    }
  }
  return [attachmentEntry.control];
}

function isSourceDescription(control) {
  const designerType = String(control?.source?.designerType || "").toLowerCase();
  return control?.type === "description" || ["textlabel", "linklabel"].includes(designerType);
}

function isExplicitDetailTableHeading(control) {
  const values = control?.source?.designerValues || {};
  const size = Number.parseFloat(String(values.size || ""));
  return isTrueLike(values.b) && Number.isFinite(size) && size >= 16;
}

function enclosingElementRanges(html, position) {
  const ranges = [];
  const stack = [];
  for (const token of scanHtmlTags(html)) {
    if (!token.closing) {
      if (!token.selfClosing && !isVoidLikeTag(token.name)) stack.push(token);
      continue;
    }
    const openIndex = stack.findLastIndex((entry) => entry.name === token.name);
    if (openIndex < 0) continue;
    const [open] = stack.splice(openIndex, 1);
    if (open.start <= position && position < token.end) {
      ranges.push({ start: open.start, end: token.end });
    }
  }
  return ranges;
}

function isTrueLike(value) {
  return ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());
}
