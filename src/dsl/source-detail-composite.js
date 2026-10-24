import { canonicalJson } from "../agent-review/digest.js";

/** Compare only composite semantics rebuilt from the authoritative source draft. */
export function detailCompositeSourceDiagnostics(expectedForm, targetForm, { prefix = "trust.form" } = {}) {
  const tables = form => (form?.fields || []).filter(field => field.type === "detailTable");
  const expectedTables = tables(expectedForm), actualTables = tables(targetForm);
  const composite = field => field?.sourceProps?.legacyDetailComposite;
  const tableRefs = new Set([...expectedTables, ...actualTables]
    .filter(table => table.columns?.some(composite)).map(table => table.sourceRef));
  const semantics = field => field && ({
    id: field.id,
    componentId: field.componentId,
    dataOnly: field.dataOnly === true,
    required: field.props?.required === true,
    composite: composite(field)
  });
  const diagnostics = [];
  const mismatch = details => diagnostics.push({
    level: "error", code: `${prefix}.detail_composite_required_source_mismatch`, path: "/form/fields",
    message: "A source-backed detail composite must preserve requiredness on its interactive selector and keep its data-only shadow non-required. Use the source-rebuilt composite, not the raw selector flag alone.",
    details
  });
  for (const tableRef of tableRefs) {
    const before = expectedTables.filter(table => table.sourceRef === tableRef);
    const after = actualTables.filter(table => table.sourceRef === tableRef);
    if (before.length !== 1 || after.length !== 1 || before[0].id !== after[0].id) {
      mismatch({ tableSourceRef: tableRef, reason: "composite_table_binding" });
      continue;
    }
    const refs = new Set([...before[0].columns, ...after[0].columns]
      .filter(composite).map(field => field.sourceRef));
    for (const sourceRef of refs) {
      const expected = before[0].columns.filter(field => field.sourceRef === sourceRef);
      const actual = after[0].columns.filter(field => field.sourceRef === sourceRef);
      if (expected.length === 1 && actual.length === 1 &&
          canonicalJson(semantics(expected[0])) === canonicalJson(semantics(actual[0]))) continue;
      mismatch({ tableSourceRef: tableRef, sourceRef,
        fieldId: expected[0]?.id || actual[0]?.id,
        expectedRequired: expected.length === 1 ? expected[0].props?.required === true : null,
        actualRequired: actual.length === 1 ? actual[0].props?.required === true : null,
        memberSourceRefs: (before[0].columns || []).filter(field =>
          composite(expected[0])?.memberIds?.includes(field.id)).map(field => field.sourceRef)
      });
    }
  }
  return diagnostics;
}
