function declaration(style, name) {
  const values = String(style || "").split(";").map(part => part.split(":"))
    .filter(([key]) => key.trim().toLowerCase() === name);
  return values.at(-1)?.slice(1).join(":").replace(/\s*!important\s*$/i, "").trim();
}

export function sourceTextAlign(style, align) {
  const value = String(declaration(style, "text-align") || align || "").trim().toLowerCase();
  return ["left", "center", "right", "justify"].includes(value) ? value : undefined;
}

/** Source-only presentation facts; arbitrary CSS never crosses this boundary. */
export function descriptionPresentation(values, style) {
  const presentation = {};
  const size = String(declaration(style, "font-size") || values.size || "").trim();
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(size);
  if (match && Number.isFinite(Number(match[1]))) presentation.fontSize = Number(match[1]);
  const align = sourceTextAlign(style);
  if (align) presentation.textAlign = align;
  return Object.keys(presentation).length ? presentation : undefined;
}
