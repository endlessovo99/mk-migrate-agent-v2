# Agent Instructions

This repo is a v2 route-validation rebuild. Keep it narrow.

## Product Boundary

The product is a migration execution tool. Agent work may implement DSL generation, DSL repair, dry-run planning, and the narrow NewOA SIT executor path described by route-validation fixtures.

NewOA writes are allowed only for the executor implementation path when all of these are true:

- The target is `https://p-sit.onewo.com`.
- The template is a new `MK_TEST_` draft template.
- The caller provides explicit write confirmation and a target category `fdId`.
- Credentials are provided through environment variables.
- Default tests use fake clients and do not access NewOA.

## Engineering Rules

- Keep CLI and modules small.
- Prefer API-first execution.
- Do not use browser automation for the v2 executor path.
- Do not port broad v1 modules wholesale.
- Add features only when a fixture and a route-validation test exist.
- Preserve DSL as the only public boundary between translation and execution.

## Current Non-Goals

- No frontend.
- No batch.
- No source formats outside the current XML route-validation scope.
- Current source input is either `*_SysFormTemplate.xml` or a paired directory with `*_SysFormTemplate.xml` and `*_LbpmProcessDefinition.xml`.
- No PI/Agent execution.
- No production writes without explicit confirmation.
