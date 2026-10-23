# Empty selector initialization Route case

This minimal source retains the payment form's two onLoad callbacks: read the
single String `fd_fkfs` select through a DOM element's `.value`, then show ticket
type/payment rows only when it contains `B`. The source select explicitly shows
an empty "please select" option. It reproduces the migrated onLoad exception for
an uninitialized NewOA selector without including the business corpus.

The route follows XML intake, deterministic DSL generation, and native
projection. Its persisted onLoad must hide both rows for `undefined`, `null`,
`[]`, `''`, `'A'`, and `['A']`, show them for `'B'` / `['B']`, and reject invalid
non-String/multiple-selection values without silently coercing them. Other
source field kinds keep their existing read behavior.
