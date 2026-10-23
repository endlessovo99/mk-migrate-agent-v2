import { createHash } from "node:crypto";
import { nativeStylesheet, nativeStylesheetCss } from "./native-stylesheet.js";

const PREFIX = "mk-choice-other-flow-";
const ROLE = "mk-choice-other-";
const ROWS = ["checkbox", "radio", "m-checkbox", "m-radio"].flatMap(kind =>
  ["row", "column"].map(direction => `.ele-xform-${kind}-group-${direction}`)).join(",");

/** Source-proven, same-line companions only. No option codes or field identities change. */
export function choiceOtherFlowGroups(flow, fields = []) {
  const byId = new Map(fields.flatMap(field => [[field.id, field], [field.sourceProps?.originalId || field.id, field]]));
  const groups = [];
  for (const choice of fields) {
    const relation = choice.sourceProps?.otherTextCompanion, text = byId.get(relation?.id);
    if (!relation || !["xform-checkbox", "xform-radio"].includes(choice.componentId) || choice.dataOnly ||
        !text || text.componentId !== "xform-input" || text.dataOnly ||
        !choice.props?.hiddenLabel || !text.props?.hiddenLabel ||
        fields.filter(field => field.sourceProps?.otherTextCompanion?.id === relation.id).length !== 1) continue;
    const caption = byId.get(relation.captionId);
    const tail = relation.optionValue !== undefined &&
      choice.props?.options?.at(-1)?.value === relation.optionValue &&
      choice.props.options.every(option => option.type !== "other" && option.value !== "other_");
    const referenceIds = tail && (!caption || caption.dataOnly) ? [choice.id, text.id]
      : relation.optionValue === undefined && caption && !caption.dataOnly ? [caption.id, text.id] : [];
    if (!referenceIds.length) continue;
    const lineIndex = flow.lines.findIndex(line => {
      const i = line.indexOf(referenceIds[0]);
      return i >= 0 && line[i + 1] === text.id;
    });
    const width = flow.items.find(item => item.referenceId === text.id)?.width || { value: 192, unit: "px" };
    if (lineIndex < 0 || width.value <= 0) continue;
    groups.push({ lineIndex, referenceIds, mode: tail ? "tail" : "caption", width: { ...width } });
  }
  return groups;
}

export function choiceOtherGroupScope(group) {
  return PREFIX + createHash("sha256").update(JSON.stringify(group)).digest("hex").slice(0, 16);
}

export function choiceOtherGroupStyle(group) {
  return group.mode === "tail" ? {
    display: "block", flex: "1 1 100%", width: "100%", minWidth: 0,
    "--mk-choice-other-note-width": `min(${group.width.value}${group.width.unit}, 50%)`
  } : {
    display: "inline-flex", flexWrap: "nowrap", alignItems: "center", minWidth: 0, maxWidth: "100%",
    "--mk-choice-other-note-width": `${group.width.value}${group.width.unit}`
  };
}

export function choiceOtherGroupCss(scope, mode) {
  const root = `.${scope}`, choice = `${root} > .${ROLE}choice`, note = `${root} > .${ROLE}note`;
  const rows = `:is(${ROWS})`;
  return [
    ...(mode === "tail" ? [
      // Flatten only ancestors of the actual native option rows. The native
      // field and its React ownership, events and selection state stay intact.
      `${choice}, ${choice} :has(${rows}) { display: contents !important; }`,
      `${choice} ${rows} { display: block !important; }`,
      `${choice} ${rows}:last-child { display: contents !important; }`,
      // Reserve the textbox *inside* the last option's atomic inline box. Its
      // negative leading margin consumes that reservation, including after wrap.
      `${choice} ${rows}:last-child > :last-child {`,
      "  display: inline-flex !important;",
      "  vertical-align: middle !important;",
      "  padding-right: calc(var(--mk-choice-other-note-width) + 8px) !important;",
      "  margin-right: 0 !important;",
      "}",
      `${choice} ${rows}:last-child > :last-child > * { margin-right: 0 !important; }`,
      `${root}:has(> .${ROLE}choice ${rows}) > .${ROLE}note {`,
      "  display: inline-block !important;",
      "  margin-left: calc(-1 * var(--mk-choice-other-note-width)) !important;",
      "  vertical-align: middle !important;",
      "}"
    ] : []),
    `${note} { width: var(--mk-choice-other-note-width) !important; }`,
    `${note} .ele-xform-fieldset { padding: 0 !important; }`,
    `${note} .ele-xform-fieldset-control { padding-top: 0 !important; padding-bottom: 0 !important; }`
  ].join("\n");
}

export function buildChoiceOtherGroup(group, items) {
  const scope = choiceOtherGroupScope(group);
  return {
    key: scope, type: "div", kind: "container",
    controlProps: { id: scope, className: scope, style: choiceOtherGroupStyle(group) },
    children: [
      nativeStylesheet(`${scope}-styles`, choiceOtherGroupCss(scope, group.mode)),
      ...items.map((item, i) => ({ ...item, controlProps: { ...item.controlProps,
        className: [i === 0 ? `${ROLE}choice` : `${ROLE}note`, item.controlProps.className].filter(Boolean).join(" ") } }))
    ]
  };
}

/** Decode from actual native hierarchy and CSS, independently of migration audit markers. */
export function observeChoiceOtherGroup(node) {
  const scope = node?.controlProps?.className;
  if (typeof scope !== "string" || !new RegExp(`^${PREFIX}[a-f0-9]{16}$`).test(scope)) return undefined;
  if (node.type !== "div" || node.kind !== "container" || node.children?.length !== 3 ||
      Object.keys(node.controlProps).some(key => !["id", "className", "style"].includes(key))) return { invalid: true };
  const [carrier, ...items] = node.children, style = node.controlProps.style;
  const mode = style?.display === "block" ? "tail" : "caption";
  const match = (mode === "tail" ? /^min\((\d+(?:\.\d+)?)(px|%), 50%\)$/ : /^(\d+(?:\.\d+)?)(px|%)$/)
    .exec(style?.["--mk-choice-other-note-width"]);
  if (!match || Number(match[1]) <= 0 || items.some(item => item?.children?.length !== 1 || typeof item.children[0]?.key !== "string")) return { invalid: true };
  const group = { referenceIds: items.map(item => item.children[0].key), mode, width: { value: Number(match[1]), unit: match[2] } };
  const same = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());
  if (!same(style, choiceOtherGroupStyle(group)) ||
      nativeStylesheetCss(carrier) !== choiceOtherGroupCss(scope, mode) ||
      items.some((item, i) => ![`${ROLE}${i ? "note" : "choice"}`, `${ROLE}${i ? "note" : "choice"} mk-adaptive-main-field`].includes(item.controlProps?.className))) return { invalid: true };
  return { group, items };
}

export function isChoiceOtherStyleCarrier(node) {
  return nativeStylesheetCss(node) !== undefined && new RegExp(`^${PREFIX}[a-f0-9]{16}-styles$`).test(node.key);
}
