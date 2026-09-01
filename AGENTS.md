# Agent Instructions

This repo is a v2 route-validation rebuild. Keep it narrow.

## Product Boundary

The product is a migration execution tool. Agent work may implement DSL generation, DSL repair, dry-run planning, and the narrow NewOA executor path described by route-validation fixtures.

NewOA writes are allowed only for the executor implementation path when all of these are true:

- The target is an explicitly configured valid HTTP/HTTPS root origin, or the default `https://p-sit.onewo.com` when no base URL is configured.
- The template is a new `MK_TEST_` draft template, unless the caller explicitly confirms the scoped published-form repair path below.
- The caller provides explicit write confirmation and a target category `fdId`.
- Credentials are provided through environment variables.
- Default tests use fake clients and do not access NewOA.

An explicitly confirmed published-form repair may update only the current official form version of a named `MK_TEST_` template through `sysXFormOfficial/save`. It requires a matching target/category and snapshot digest, explicit field/action lists, private backups, and readback verification. Only enabling source-backed readonly permissions and preserving empty-text reads in existing onLoad actions are allowed. Template identity, publication state, data models, layout, unrelated form content, and workflow definitions must remain unchanged. The normal draft-only executor gate must not be weakened, and uncertain writes must not be retried.

An explicitly confirmed locked-draft recovery may act only on a named, still-draft `MK_TEST_` template that was created by a retained `readback_failed` execution report and never reached the transfer-record callback. A record-only reconciliation performs two stable readbacks and complete persisted-invariant verification before one transfer-record request; it must never call a template or workflow write API. A scoped repair additionally requires approved full DSL/report digests, a stable current snapshot digest, an unused private artifacts directory, private before/after backups, and a persistent single-attempt state file. The only permitted repair deltas are the exact template-authorization collection normalization evidenced by the prior report, or the three native calculation paths for the evidenced detail-row formula and aggregate rule. Template identity, category, lifecycle, table and field identity, layout, unrelated form configuration, scripts, workflow graph/content, and publication state must remain unchanged. Any template, workflow, or transfer-record write whose result is uncertain locks the operation permanently and must not be retried. This exception must not weaken the normal new-draft executor or the published-form repair gate.

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
- Current source input is either `*_SysFormTemplate.xml` or a paired directory with `*_SysFormTemplate.xml` and `*_LbpmProcessDefinition.xml`, optionally plus `*_KmReviewTemplate.xml` for the authoritative template name and, only when its root `fdId` matches both paired template IDs, fail-closed recovery of exact workflow person source identity evidence from fixed root author/authorization containers.
- No PI/Agent execution.
- No production writes without explicit confirmation.
