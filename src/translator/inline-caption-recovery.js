import {
  isSourceDescriptionControl,
  isStyledSourceDescriptionControl
} from "./source-description-control.js";
import { scanHtmlTags } from "./designer-html-tokenizer.js";
import {
  hasSubjectCaptionAffinity,
  isSafeInlineUnit
} from "./source-text-predicates.js";
import { cleanText } from "./xml-utils.js";

export function foldInlineCaptions(html, entries, options = {}) {
  const folded = [];

  for (let index = 0; index < entries.length;) {
    const current = entries[index];
    const next = entries[index + 1];
    if (!next || current.control.source?.designerHidden || next.control.source?.designerHidden) {
      folded.push(current);
      index += 1;
      continue;
    }

    const separatedByBreak = hasDesignerBreakBetween(html, current, next);
    if (
      !isSourceDescriptionControl(current.control) &&
      isPlainInlineCaption(next.control) &&
      !separatedByBreak
    ) {
      const canonicalTitle = ordinalCaptionTitle(current.control.title, next.control.title);
      if (canonicalTitle) {
        folded.push(mergedEntry(
          current,
          next,
          withInlineCaption(current.control, next.control, canonicalTitle, "trailing-ordinal-caption")
        ));
        index += 2;
        continue;
      }

      if (captionMatchesExactTitle(next.control.title, current.control.title)) {
        folded.push(mergedEntry(
          current,
          next,
          withInlineCaption(
            current.control,
            next.control,
            current.control.title,
            "trailing-duplicate-caption"
          )
        ));
        index += 2;
        continue;
      }
    }

    // A bound caption in another cell of the same row is the formal field
    // subject. A directly leading, punctuated label in the value cell is the
    // distinct visible caption.
    if (
      isPlainInlineCaption(current.control) &&
      !isSourceDescriptionControl(next.control) &&
      !separatedByBreak &&
      isCrossCellBoundTextSubject(next.control, options.crossCellBoundCaptionIds) &&
      hasOnlyInlineWhitespaceBetween(html, current, next) &&
      hasTerminalCaptionPunctuation(current.control.title) &&
      hasSubjectCaptionAffinity(
        current.control.title,
        next.control.source?.boundCaption?.content
      )
    ) {
      folded.push(mergedEntry(
        current,
        next,
        withBoundSubjectCaption(next.control, current.control)
      ));
      index += 2;
      continue;
    }

    if (
      isPlainInlineCaption(current.control) &&
      !isSourceDescriptionControl(next.control) &&
      !separatedByBreak &&
      captionMatchesTitleEnd(current.control.title, next.control.title)
    ) {
      folded.push(mergedEntry(
        current,
        next,
        withInlineCaption(next.control, current.control, next.control.title, "leading-title-segment")
      ));
      index += 2;
      continue;
    }

    // Visible plain textLabel + unbound input subject: UI title is the caption;
    // designer/metadata label is only the field subject, not a second title.
    if (
      isPlainInlineCaption(current.control) &&
      !isSourceDescriptionControl(next.control) &&
      !separatedByBreak &&
      isUnboundSubjectField(next.control) &&
      !isSafeInlineUnit(current.control.title)
    ) {
      folded.push(mergedEntry(
        current,
        next,
        withUnboundSubjectCaption(next.control, current.control)
      ));
      index += 2;
      continue;
    }

    folded.push(current);
    index += 1;
  }

  return folded;
}

export function isPlainInlineCaption(control) {
  return isSourceDescriptionControl(control) &&
    String(control.source?.designerType || "").toLowerCase() === "textlabel" &&
    !isStyledSourceDescriptionControl(control);
}

function isUnboundSubjectField(control) {
  return String(control?.source?.designerValues?._label_bind || "").toLowerCase() === "false";
}

function isCrossCellBoundTextSubject(control, crossCellBoundCaptionIds) {
  const values = control?.source?.designerValues || {};
  const boundCaption = control?.source?.boundCaption;
  return String(control?.source?.designerType || "").toLowerCase() === "inputtext" &&
    String(values._label_bind || "").toLowerCase() === "true" &&
    Boolean(
      boundCaption?.id &&
      values._label_bind_id &&
      boundCaption.id === values._label_bind_id &&
      crossCellBoundCaptionIds?.has(boundCaption.id)
    );
}

function hasTerminalCaptionPunctuation(value) {
  return /[:：]\s*$/u.test(cleanText(value));
}

function hasOnlyInlineWhitespaceBetween(html, left, right) {
  const between = String(html || "").slice(left.end, right.start);
  if (!scanHtmlTags(between).next().done) return false;
  return between
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(?:\s|&#(?:x[0-9a-f]+|\d+);|&nbsp;)+/gi, "") === "";
}

function hasDesignerBreakBetween(html, left, right) {
  const between = String(html || "").slice(left.end, right.start);
  return /\bfd_type\s*=\s*(["'])brcontrol\1/i.test(between);
}

function withUnboundSubjectCaption(control, caption) {
  return withSubjectCaption(control, caption, {
    inlineRelation: "leading-unbound-subject-caption",
    subjectRelation: "unbound-control-subject-distinct-from-visible-caption"
  });
}

function withBoundSubjectCaption(control, caption) {
  return withSubjectCaption(control, caption, {
    inlineRelation: "leading-bound-subject-caption",
    subjectRelation: "bound-control-subject-distinct-from-visible-caption"
  });
}

function withSubjectCaption(control, caption, relations) {
  const subject = cleanText(control.source?.designerValues?.label || control.title);
  const displayTitle = inlineCaptionText(caption.title);
  const folded = withInlineCaption(
    control,
    caption,
    displayTitle,
    relations.inlineRelation
  );
  if (!subject || normalizeSemanticText(subject) === normalizeSemanticText(displayTitle)) {
    return folded;
  }
  return {
    ...folded,
    source: {
      ...folded.source,
      subjectLabel: {
        content: subject,
        relation: relations.subjectRelation
      }
    }
  };
}

function ordinalCaptionTitle(fieldTitle, captionTitle) {
  const title = cleanText(fieldTitle);
  const match = /^(.*\S)([0-9０-９]+)$/u.exec(title);
  if (!match) return undefined;
  const caption = inlineCaptionText(captionTitle);
  if (!caption || normalizeSemanticText(match[1]) !== normalizeSemanticText(caption)) return undefined;
  return caption;
}

function captionMatchesTitleEnd(captionTitle, fieldTitle) {
  const caption = normalizeSemanticText(inlineCaptionText(captionTitle));
  if (!caption) return false;
  const segments = cleanText(fieldTitle)
    .split(/\s*[-–—/／|｜:：]\s*/u)
    .map(normalizeSemanticText)
    .filter(Boolean);
  return segments.length > 0 && segments.at(-1) === caption;
}

function captionMatchesExactTitle(captionTitle, fieldTitle) {
  const caption = normalizeSemanticText(inlineCaptionText(captionTitle));
  const field = normalizeSemanticText(inlineCaptionText(fieldTitle));
  return Boolean(caption && field && caption === field);
}

function inlineCaptionText(value) {
  return cleanText(value).replace(/^[\s:：,，;；]+|[\s:：,，;；]+$/gu, "");
}

function normalizeSemanticText(value) {
  return cleanText(value).replace(/\s+/g, "").toLocaleLowerCase();
}

function withInlineCaption(control, caption, title, relation) {
  return {
    ...control,
    title,
    source: {
      ...control.source,
      inlineCaption: {
        id: caption.id,
        content: inlineCaptionText(caption.title),
        relation
      }
    }
  };
}

function mergedEntry(left, right, control) {
  return {
    control,
    start: left.start,
    end: right.end
  };
}
