# Detail program translation prerequisites

The detail-program modules provide two internal building blocks. They do not
register a new executable DSL recipe, suppress a source residual, or authorize a
NewOA write.

`legacy-detail-program-ir.js` compiles complete, ordered source script blocks
into a limited instruction representation. It preserves function and `var`
hoisting, mode gates, and late global-helper binding across blocks. Its runtime
cannot access ambient browser objects or evaluate handler strings. Every DOM
operation goes through an explicit host adapter; unsupported syntax and
operations fail closed. Inline handler requirements remain visible in the
operation inventory and require separate binding proof.

`native-detail-control-bridge.js` provides a runtime cell-component adapter for
the inspected native desktop detail table. It retains the native column type
and editor, stores cell properties by row identity, and preserves repeated
radio clicks through the native value notification. Its caller must provide
source ownership, field binding, lifecycle, and deployment capability proof.
This module is not a generic permission to use React or DOM APIs in DSL
scripts.

Before these building blocks may form an executable recipe, the implementation
must supply and test all of the following:

- Source-rendered ownership for every ancestor/sibling traversal and every
  document-wide selector, including edit, view, empty-value, and fallback output.
- Exact inline-handler compilation, callback order, and add/delete/move
  semantics, including clear-last-row behavior and generated default rows.
- The complete source-derived validation domain, independently of visibility
  and placeholder state.
- A fixed generated runtime admitted only by exact regeneration and independent
  source trust, with negative tests for tampering and unrepresented effects.
- A prewrite native capability check for every runtime module used by the
  bridge, plus persisted-script and workflow readback.

Passing the interpreter or component tests alone does not satisfy this list.
The existing protected detail-row residuals and normal executor gates remain
unchanged.

An exported `fdDisplayJsp` containing `xform:radio` and `xform:textarea` does not
by itself reveal those tag libraries' generated DOM. In particular, four
`nextSibling` operations count text and script nodes as well as elements. A
comment describing a replacement field, or that field's adjacent position in
the JSP, is insufficient proof of the selected runtime node. The corresponding
renderer output or versioned renderer contract is necessary before translating
that operation.
