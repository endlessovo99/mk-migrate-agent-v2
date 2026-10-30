# Bridged visibility with a source-backed blank select

This variation of the bridged row lifecycle includes a source single-select
with an explicit empty option. NewOA dispatches `null` when the selection is
cleared, while the source callback receives an empty String. The route test
keeps the source DSL unchanged, verifies the narrowly scoped native null bridge,
and fails closed if the source empty-select evidence is missing or altered.
