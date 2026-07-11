# Agent Instructions

This repo is a v2 route-validation rebuild. Keep it narrow.

## Product Boundary

The product is a migration execution tool. Agent work may implement DSL generation, DSL repair, dry-run planning, and the narrow NewOA executor path described by route-validation fixtures.

NewOA writes are allowed only for the executor implementation path when all of these are true:

- The target is an explicitly configured valid HTTP/HTTPS root origin, or the default `https://p-sit.onewo.com` when no base URL is configured.
- The template is a new `MK_TEST_` draft template.
- The caller provides explicit write confirmation and a target category `fdId`.
- Credentials are provided through environment variables.
- Default tests use fake clients and do not access NewOA.

## Engineering Rules

- Keep CLI and modules small.
- Prefer API-first execution.
- Do not use browser automation for the v2 executor path.
- Do not reference, invoke, copy from, or use the `onewo-k2-newoa-migration` skill as guidance for this project.
- Do not port broad v1 modules wholesale.
- Add features only when a fixture and a route-validation test exist.
- Preserve DSL as the only public boundary between translation and execution.

## Current Non-Goals

- No frontend.
- No batch.
- No source formats outside the current XML route-validation scope.
- Current source input is either `*_SysFormTemplate.xml` or a paired directory with `*_SysFormTemplate.xml` and `*_LbpmProcessDefinition.xml`, optionally plus `*_KmReviewTemplate.xml` for the authoritative template name.
- No PI/Agent execution.
- No production writes without explicit confirmation.
