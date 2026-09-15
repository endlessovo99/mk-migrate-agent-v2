# Public expense detail visibility

Root source4 `16d622ad41c4bb720ab81b14e2eaa0b0` form evidence with template
IDs replaced and workflow/history omitted. Nine detail rows are selected by bxlx.
Each has a mirrored hidden helper and load handler. The source-backed native load
bridge already selects visibility from bxlx; a duplicate helper-based load script
must not override it when that helper is empty/stale. Preserve required/reset
effects and do not delegate without a complete complementary native rule.
Default tests use fake persistence and a script stub, never live writes.
