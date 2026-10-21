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

Script analysis allows only completely inspected top-level local functions,
bounded value APIs, numeric builtins with proven primitive inputs and the existing exact native
calculation-library include. Unknown calls, element handles, DOM/member access,
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
