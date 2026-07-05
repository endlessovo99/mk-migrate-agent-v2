# Build v2 as a narrow route-validation rebuild

`mk-migrate-agent-v2` starts as a clean route-validation implementation, not as a full feature clone of v1. It supports one latest source shape, keeps DSL as the only public boundary, and proves the API-first NewOA write/readback route before adding frontend, batch, flow, or legacy compatibility.

**Status**: accepted

## Consequences

- v1 remains the knowledge base for NewOA behavior and fixtures, but v2 should not port broad modules wholesale.
- The first success condition is one real source file reaching a verified `MK_TEST_` template through DSL, dry-run, API write, and readback.
- Frontend, batch, PI/Agent execution, and legacy source adapters stay out of scope until the single-flow route is proven.
- `needs_manual` remains a warning/reporting state rather than an execution blocker.
