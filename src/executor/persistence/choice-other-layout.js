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
    if (!relation || !["xform-checkbox", "xform-radio", "xform-select"].includes(choice.componentId) || choice.dataOnly ||
        !text || text.componentId !== "xform-input" || text.dataOnly ||
        !choice.props?.hiddenLabel || !text.props?.hiddenLabel ||
        fields.filter(field => field.sourceProps?.otherTextCompanion?.id === relation.id).length !== 1) continue;
    const caption = byId.get(relation.captionId);
    const select = choice.componentId === "xform-select" && relation.optionValue !== undefined &&
      choice.otherPresentation?.mode === "reveal-on-selection";
    const tail = choice.componentId !== "xform-select" && relation.optionValue !== undefined &&
      choice.props?.options?.at(-1)?.value === relation.optionValue &&
      choice.props.options.every(option => option.type !== "other" && option.value !== "other_");
    const referenceIds = (tail || select) && (!caption || caption.dataOnly) ? [choice.id, text.id]
      : relation.optionValue === undefined && caption && !caption.dataOnly ? [caption.id, text.id] : [];
    if (!referenceIds.length) continue;
    const lineIndex = flow.lines.findIndex(line => {
      const i = line.indexOf(referenceIds[0]);
      return i >= 0 && line[i + 1] === text.id;
    });
    const width = flow.items.find(item => item.referenceId === text.id)?.width || { value: 192, unit: "px" };
    if (lineIndex < 0 || width.value <= 0) continue;
    const trigger = tail || select ? choice : caption, presentation = choice.otherPresentation;
    const revealOnSelection = presentation?.version === 1 && presentation.mode === "reveal-on-selection" &&
      presentation.textSourceRef === text.sourceRef && presentation.triggerSourceRef === trigger.sourceRef &&
      presentation.optionValue === (tail || select ? relation.optionValue : "selected");
    groups.push({ lineIndex, referenceIds, mode: select ? "select" : tail ? "tail" : "caption", width: { ...width },
      ...(revealOnSelection ? { revealOnSelection: true } : {}) });
  }
  return groups;
}

export function choiceOtherGroupScope(group) {
  return PREFIX + createHash("sha256").update(JSON.stringify(group)).digest("hex").slice(0, 16);
}

export function choiceOtherGroupStyle(group) {
  if (group.mode === "select") return {
    display: "flex", flexWrap: "wrap", alignItems: "center", width: "100%", minWidth: 0,
    "--mk-choice-other-note-width": `min(${group.width.value}${group.width.unit}, 50%)`,
    "--mk-choice-other-kind": "select", "--mk-choice-other-reveal": "selected"
  };
  return group.mode === "tail" ? {
    display: "block", flex: "1 1 100%", width: "100%", minWidth: 0,
    "--mk-choice-other-note-width": `min(${group.width.value}${group.width.unit}, 50%)`,
    ...(group.revealOnSelection ? { "--mk-choice-other-reveal": "selected" } : {})
  } : {
    display: "inline-flex", flexWrap: "nowrap", alignItems: "center", minWidth: 0, maxWidth: "100%",
    "--mk-choice-other-note-width": `${group.width.value}${group.width.unit}`,
    ...(group.revealOnSelection ? { "--mk-choice-other-reveal": "selected" } : {})
  };
}

export function choiceOtherGroupCss(scope, mode, revealOnSelection = false) {
  const root = `.${scope}`, choice = `${root} > .${ROLE}choice`, note = `${root} > .${ROLE}note`;
  const rows = `:is(${ROWS})`;
  const interactive = `> .${ROLE}choice input[type="checkbox"], > .${ROLE}choice input[type="radio"]`;
  const selected = mode === "tail" ? `> .${ROLE}choice ${rows}:last-child > :last-child input:checked`
    : `> .${ROLE}choice input:checked`;
  const disabled = mode === "tail" ? `> .${ROLE}choice ${rows}:last-child > :last-child input:disabled`
    : `> .${ROLE}choice input:disabled`;
  const required = `> .${ROLE}note .ele-xform-fieldset-required`;
  const protectedNote = `> .${ROLE}note input[readonly], > .${ROLE}note input:disabled, > .${ROLE}note textarea[readonly], > .${ROLE}note textarea:disabled`;
  const noteInput = `> .${ROLE}note input:not([type="hidden"]), > .${ROLE}note textarea`;
  return [
    ...(mode === "tail" ? [
      // Flatten only ancestors of the actual native option rows. The native
      // field and its React ownership, events and selection state stay intact.
      `${choice}, ${choice} :has(${rows}) { display: contents !important; }`,
      `${choice} ${rows} { display: block !important; }`,
      `${choice} ${rows}:last-child { display: contents !important; }`,
      // Native checkbox labels are display:flex. Once their flex-row parent is
      // flattened, keep every option atomic and inline, not just the last one.
      // Separate native rows still provide the source's vertical row breaks.
      `${choice} ${rows} > * { display: inline-flex !important; vertical-align: middle !important; }`,
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
    ...(revealOnSelection && mode === "select" ? [
      `${choice} { flex: 1 1 12rem !important; min-width: 0 !important; }`,
      `${note} { flex: 0 1 var(--mk-choice-other-note-width) !important; min-width: 0 !important; }`,
      `${root}[data-mk-other-state="closed"] > .${ROLE}note { display: none !important; }`
    ] : revealOnSelection ? [
      // Preserve the field and its value. Only the visual wrapper is hidden;
      // if a native read-only view has no input, leave its existing data visible.
      `${root}:has(${interactive}) > .${ROLE}note { display: none !important; }`,
      `${root}:has(${selected}) > .${ROLE}note { display: inline-block !important; }`,
      ...(mode === "tail" ? [
        `${root}:has(${interactive}) > .${ROLE}choice ${rows}:last-child > :last-child { padding-right: 0 !important; }`,
        `${root}:has(${selected}) > .${ROLE}choice ${rows}:last-child > :last-child { padding-right: calc(var(--mk-choice-other-note-width) + 8px) !important; }`
      ] : [
        `${choice} .ele-xform-fieldset-wrap { padding-right: 0 !important; }`,
        `${choice} ${rows} > * { margin-right: 0 !important; }`
      ])
    ] : []),
    ...(revealOnSelection ? [
      // A native source rule may make an otherwise optional note required.
      // Keep it reachable rather than creating an invisible validation blocker.
      `${root}:has(${required}) > .${ROLE}note.${ROLE}note { display: inline-block !important; }`,
      `${root}:has(${protectedNote}) > .${ROLE}note.${ROLE}note { display: inline-block !important; }`,
      `${root}:not(:has(${noteInput})) > .${ROLE}note.${ROLE}note { display: inline-block !important; }`,
      ...(mode !== "select" ? [
        `${root}:has(${disabled}) > .${ROLE}note.${ROLE}note { display: inline-block !important; }`
      ] : []),
      ...(mode === "tail" ? [
        `${root}:has(${required}) > .${ROLE}choice ${rows}:last-child > :last-child { padding-right: calc(var(--mk-choice-other-note-width) + 8px) !important; }`,
        `${root}:has(${protectedNote}) > .${ROLE}choice ${rows}:last-child > :last-child { padding-right: calc(var(--mk-choice-other-note-width) + 8px) !important; }`,
        `${root}:not(:has(${noteInput})) > .${ROLE}choice ${rows}:last-child > :last-child { padding-right: calc(var(--mk-choice-other-note-width) + 8px) !important; }`,
        `${root}:has(${disabled}) > .${ROLE}choice ${rows}:last-child > :last-child { padding-right: calc(var(--mk-choice-other-note-width) + 8px) !important; }`
      ] : [])
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
      nativeStylesheet(`${scope}-styles`, choiceOtherGroupCss(scope, group.mode, group.revealOnSelection)),
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
  const mode = style?.["--mk-choice-other-kind"] === "select" ? "select" : style?.display === "block" ? "tail" : "caption";
  const match = (mode === "tail" || mode === "select" ? /^min\((\d+(?:\.\d+)?)(px|%), 50%\)$/ : /^(\d+(?:\.\d+)?)(px|%)$/)
    .exec(style?.["--mk-choice-other-note-width"]);
  if (!match || Number(match[1]) <= 0 || items.some(item => item?.children?.length !== 1 || typeof item.children[0]?.key !== "string")) return { invalid: true };
  const revealOnSelection = style?.["--mk-choice-other-reveal"] === "selected";
  const group = { referenceIds: items.map(item => item.children[0].key), mode, width: { value: Number(match[1]), unit: match[2] },
    ...(revealOnSelection ? { revealOnSelection: true } : {}) };
  const same = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());
  if (!same(style, choiceOtherGroupStyle(group)) ||
      nativeStylesheetCss(carrier) !== choiceOtherGroupCss(scope, mode, revealOnSelection) ||
      items.some((item, i) => ![`${ROLE}${i ? "note" : "choice"}`, `${ROLE}${i ? "note" : "choice"} mk-adaptive-main-field`].includes(item.controlProps?.className))) return { invalid: true };
  return { group, items };
}

export function isChoiceOtherStyleCarrier(node) {
  return nativeStylesheetCss(node) !== undefined && new RegExp(`^${PREFIX}[a-f0-9]{16}-styles$`).test(node.key);
}
