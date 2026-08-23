export function isStaticHeaderGridShape(controlRows = []) {
  if (controlRows.length < 4) return false;
  const [header, ...body] = controlRows;
  if (header.length < 3) return false;
  if (!header.every(isNonEmptyDescriptionCell)) return false;

  return body.every((row) => {
    if (row.length !== header.length) return false;
    const firstInputCell = row.findIndex(hasInputControl);
    if (firstInputCell < 2) return false;
    return row.slice(firstInputCell).every(hasInputControl);
  });
}

function isNonEmptyDescriptionCell(cell = []) {
  return cell.length > 0 && cell.every((control) => control.description === true);
}

function hasInputControl(cell = []) {
  return cell.some((control) => control.description !== true);
}
