# Source-backed native field titles

Fresh translation can consume an independent plain caption into its unique
field's native title. It removes only that description control and joins the
two occupied cells. Field identity, component, constraints, defaults, scripts,
workflow and the existing source-grid projection remain protected.

The extractor accepts ordinary standard-table exporter metadata and outer table
alignment, plus the native default 14px caption size. A malformed row remains
ineligible; another complete row may still provide evidence. Duplicate IDs are
counted across the complete markup, including malformed rows. Unknown JSP,
stylesheets, guarded ancestors and non-default caption appearance remain
unproven or protected.

An inactive Designer binding flag is insufficient on its own. A unique matching
runtime editor in the corresponding value cell can prove ownership. Shared
captions, independently permissioned controls/captions, hidden owners, row-spanning
or compound regions and conflicting source references stay separate.

The initial data-only script guard accepts completely inspected local functions,
bounded value APIs, numeric builtins with proven primitive inputs and the exact
native calculation-library include. The bounded-effect fallback described below
can prove selected DOM operations. Unknown calls, unbounded DOM/member access,
dynamic field identities, shadowed callees and unknown scope remain opaque.
These are conservative protections: removing a formatting blocker does not
authorize folding every title in a scripted form.

Each candidate has a `review.captionFolding` decision:

- `folded`: source evidence proves a unique plain title and complete region.
- `preserved`: a known shared, permission, reference or presentation constraint.
- `unproven`: static appearance, ownership, scripts or geometry is not proven.

`auditCaptionFolding(source, draft)` independently rebuilds expected decisions,
rejects missing/forged reports, requires every expected fold and verifies retained
captions. It does not promote the draft to Trusted DSL. Existing retained Source
Drafts without caption facts preserve their earlier independent-caption behavior.

## Offline corpus verification

Prepare a local JSON manifest with `items` containing `id`, `name`, `sourcePath`.
Optionally supply `previousDslPath` pointing to an immutable prior item report
whose `dsl` contains the previous migration result.

```sh
node scripts/verify-caption-folding.mjs manifest.json new-output-directory
```

The output directory must not exist. The harness writes private Source Drafts,
DSL Drafts, a detailed JSON report and a Markdown table. It blocks network fetch,
does not load a NewOA client or batch store, and never writes to input exports or
earlier reports. It compares against an in-memory retained-caption translation to
check unrelated field semantics, scripts, workflow, rules and grid projection.

Native checks use a synthetic form projection; template authorization, scripts
and workflow execution are excluded. Existing mapped button callbacks needed by
form serialization are retained as inert configuration, never executed or replaced
with empty actions. Every form with a fold must pass native
projection, title visibility on desktop/mobile and absence of the consumed
description. An unchanged form may expose a separate projection limitation such
as a button needing reviewed script translation; this is reported explicitly.
`verified` means the caption audit and preservation checks passed. `unproven`
decisions are not counted as merge success or full migration acceptance.

These checks do not prove browser rendering, live persistence, model review or
business behavior. Migration execution and updates of existing forms require
their separate authorization and gates.

## Exporter evidence and bounded runtime programs

Caption proof reads the original Designer markup, before the legacy layout
parser's entity decoding. This keeps escaped editor values from being reparsed
as outer markup. Literal boundary whitespace and one bare terminal `BR` are
accepted only when the literal caption records a trailing newline; interior
line breaks and styled breaks remain protected. Repeated words in different
cells match by their unique physical table/cell position, not a global text
search. Address editors require one matching id/name binding pair.

The exporter can mirror `text-align` and `vertical-align` into `style_*`
attributes and record unused border widths as `null`. Mirrors must agree with
the actual style (or its allowed default); substantive borders, non-default
appearance, malformed regions and conflicting metadata stay separate.

For caption proof, every runtime script body and `on*` handler is inventoried
independently of the migration mapper's Designer-first script registry. This
includes handlers on text controls masked from layout inspection. Unknown
attributes make the runtime domain incomplete and block folding. The exact
static native toolbar icon `c:url` declarations are normalized before complete
attribute parsing; dynamic URLs and additional attributes still face the same
guards. The native `__xformDispatch` marker retains its existing contract.

When the earlier data-only guard cannot prove a program, a closed static
interpreter may establish fixed field and row effects. It never executes source
code. It accepts bounded value-change/load/timer callbacks, primitive value
operations and fixed field selectors; all effects and DOM reads protect the
referenced field, caption or source ancestor. A source row helper resolves the
complete row even when a hidden metadata field shares its marker ID. Unknown
calls/identities, nonlocal mutation, mutable closure captures, unbound functions,
callee overrides, lexical bindings, nested expression assignments and DOM
traversal reject the whole program.

Generated detail-runtime programs must match complete AST templates, with no
additional statements. Standard no-argument toolbar actions protect all exported
registered detail tables. Width programs also record enclosing cell reads, so
folding cannot alter a cell they measure. The native library declarations use
the existing v2 exporter contracts. This is not a general JavaScript, jQuery or
CSS interpreter.

Decisions include `evidence.reason` for the first unresolved static/script
proof. Diagnostics with AST offsets identify the unique combined script index;
final target-domain checks identify the unresolved target. Later blockers may
become visible after the first issue is resolved.
Passing one static check never bypasses ownership, shared-title, permission,
script, or occupied-region checks.

### Bounded data programs

The effect proof distinguishes primitive data, immutable inspected arrays,
Date instances created from primitive inputs, DOM handles and plain literal
records. It can inspect primitive array membership and every callback of a
fixed array's `some`, native Date reads/comparisons, formatting and numeric Math
calls. Only `const` at a program/function body root is accepted; nested lexical
bindings, reassignment and conflicting global declarations still reject.

Existing v2 local currency helpers may use the established pure-data proof,
wrapped in an explicit syntax whitelist and reserved-binding/mutation checks.
Tagged templates, prototype deletion, unknown syntax/calls and external effects
cannot acquire this proof. Source code is never executed.

The exact native submit registration is inspected like other known callbacks.
Attachment reads are limited to an existing attachment control's `fileList.length`.
An unbounded `window.event.target` read remains unproven.

A literal dictionary lookup can use a finite native single-select event domain
only when the source's rendered options are proven and exactly match its Source
options. Inherited/prototype keys, arbitrary objects, accessors, functions and
unknown keys reject. The proof records this domain assumption and revokes it
when any inspected script writes that trigger field, including through a row
helper, field handle, setter or jQuery. This does not assume arbitrary stored
strings or ordinary text inputs have an enum domain.

Workflow alias/context resolution uses the semantic form before caption
presentation is folded. A visible title must not retarget a workflow condition
that previously referred to a context value or differently named source field.
