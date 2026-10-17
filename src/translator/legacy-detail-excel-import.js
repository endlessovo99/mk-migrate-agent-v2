import { parse } from "acorn";

/** Source requirements only; native detail import has no proven positional-file contract. */
export function legacyExcelImportDescriptor(source = {}, form = {}) {
  let program;
  try { program = parse(String(source.javascript || ""), { ecmaVersion: 2020 }); }
  catch { return undefined; }
  const functions = program.body.filter(node => node.type === "FunctionDeclaration" && node.id?.name === "importExcel");
  if (functions.length !== 1) return undefined;
  const body = functions[0].body.body;
  const literals = new Map();
  const names = ["startRowNo", "startCellNo", "detailTableId", "detailControlIds"];
  let parseCallCount = 0;
  for (const statement of body) {
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== "Identifier" || declaration.init?.type !== "Literal" || literals.has(declaration.id.name)) return undefined;
        literals.set(declaration.id.name, declaration.init.value);
      }
    } else if (statement.type !== "ExpressionStatement" || statement.expression.type !== "CallExpression" ||
      statement.expression.callee.type !== "Identifier" || statement.expression.callee.name !== "parsingExcelContent" ||
      statement.expression.arguments.length !== 4 || statement.expression.arguments.some((node, index) => (
        node.type !== "Identifier" || node.name !== names[index]
      ))) return undefined;
    else parseCallCount += 1;
  }
  if (parseCallCount !== 1) return undefined;
  const startRowNo = literals.get("startRowNo"), startCellNo = literals.get("startCellNo");
  const tableId = literals.get("detailTableId"), rawControlIds = literals.get("detailControlIds");
  if (![startRowNo, startCellNo].every(value => Number.isInteger(value) && value >= 0) ||
    typeof tableId !== "string" || !tableId || typeof rawControlIds !== "string" || !rawControlIds) return undefined;
  const columnSlots = rawControlIds.split(";");
  const positions = new Map();
  columnSlots.forEach((id, offset) => { if (id) positions.set(id, [...(positions.get(id) || []), offset]); });
  const table = [...(form.fields || []), ...(form.detailTables || [])]
    .find(field => field?.id === tableId && (field.type === "detailTable" || field.sourceType === "detailTable"));
  const present = new Set((table?.columns || []).map(column => column.id));
  return {
    tableId, startRowNo, startCellNo, rawControlIds, columnSlots,
    sourceIndexBase: "unverified-source-JSP-contract",
    duplicateTargetSlots: [...positions].filter(([, offsets]) => offsets.length > 1)
      .map(([fieldId, columnOffsets]) => ({ fieldId, columnOffsets })),
    emptyColumnOffsets: columnSlots.flatMap((id, offset) => id === "" ? [offset] : []),
    tableDefinitionFound: Boolean(table),
    missingFieldIds: [...positions.keys()].filter(id => !present.has(id)),
    sourceRefs: [source.sourceRef || source.id].filter(Boolean),
    nativeImplementationVerified: false
  };
}
