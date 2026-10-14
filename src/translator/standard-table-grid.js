export function isStaticHeaderGridShape(controlRows = []) {
  if (controlRows.length < 2) return false;
  const [header, ...body] = controlRows;
  if (rowColumns(header) < 3 || header.filter(isNonEmptyDescriptionCell).length < 2) return false;
  if (!header.every(cell => controls(cell).length === 0 || isNonEmptyDescriptionCell(cell))) return false;
  if (!body.every(row => rowColumns(row) === rowColumns(header))) return false;

  // A blank corner and later merged explanation rows do not remove the column
  // headings. Require an input row that actually aligns with those headings.
  return body.some(row => row.filter(cell => hasInputControl(cell) && header.some(heading =>
    isNonEmptyDescriptionCell(heading) && heading.column === cell.column && heading.colspan === cell.colspan
  )).length >= 2);
}

export function isStaticDescriptionGridShape(controlRows = []) {
  if (controlRows.length < 2) return false;
  const [header, ...body] = controlRows;
  if (header.length < 3) return false;
  if (!header.every(isNonEmptyDescriptionCell)) return false;
  if (!body.length) return false;

  return body.every((row) =>
    row.length === header.length && rowColumns(row) === rowColumns(header) && row.every(isNonEmptyDescriptionCell)
  );
}

function isNonEmptyDescriptionCell(cell = []) {
  return controls(cell).length > 0 && controls(cell).every((control) => control.description === true);
}

function hasInputControl(cell = []) {
  return controls(cell).some((control) => control.description !== true);
}

function controls(cell) { return cell.controls || cell; }
function rowColumns(row) {
  return Math.max(0, ...row.map((cell, index) => (cell.column ?? index) + (cell.colspan ?? 1)));
}
