# Agent Instructions

This repo is a v2 route-validation rebuild. Keep it narrow.

## Product Boundary

The product is a migration execution tool. Agent work stops at DSL generation or DSL repair and must not directly execute NewOA writes.

## Engineering Rules

- Keep CLI and modules small.
- Prefer API-first execution.
- Treat browser automation as login/fallback infrastructure only.
- Do not port broad v1 modules wholesale.
- Add features only when a fixture and a route-validation test exist.
- Preserve DSL as the only public boundary between translation and execution.

## Current Non-Goals

- No frontend.
- No batch.
- No legacy Landray/K2 source compatibility.
- The only current source input is `*_SysFormTemplate.xml`.
- No PI/Agent execution.
- No production writes without explicit confirmation.
