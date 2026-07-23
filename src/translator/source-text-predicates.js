import { cleanText } from "./xml-utils.js";

export function isSafeInlineUnit(value) {
  const unit = cleanText(value);
  return [...unit].length > 0 &&
    [...unit].length <= 12 &&
    /^[\p{L}\p{N}%‰°℃℉¥￥/$²³·]+$/u.test(unit);
}

export function hasSubjectCaptionAffinity(caption, subject) {
  const captionText = normalizeSubjectText(caption);
  const subjectText = normalizeSubjectText(subject);
  if (!captionText || !subjectText) return false;
  if (captionText === subjectText) return true;

  const captionChars = [...captionText];
  const subjectChars = [...subjectText];
  const shorterLength = Math.min(captionChars.length, subjectChars.length);
  if (
    shorterLength >= 2 &&
    (captionText.includes(subjectText) || subjectText.includes(captionText))
  ) {
    return true;
  }

  const sharedEdge = longerSharedEdge(captionChars, subjectChars);
  const threshold = sharedEdge.some((char) => /\p{Script=Han}/u.test(char)) ? 2 : 4;
  return sharedEdge.length >= threshold;
}

function normalizeSubjectText(value) {
  return cleanText(value)
    .replace(/^[\s:：,，;；]+|[\s:：,，;；]+$/gu, "")
    .replace(/\s+/g, "")
    .toLocaleLowerCase();
}

function longerSharedEdge(left, right) {
  const prefix = [];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) break;
    prefix.push(left[index]);
  }

  const suffix = [];
  for (let offset = 1; offset <= Math.min(left.length, right.length); offset += 1) {
    if (left.at(-offset) !== right.at(-offset)) break;
    suffix.unshift(left.at(-offset));
  }
  return prefix.length >= suffix.length ? prefix : suffix;
}
