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

For the encrypted server operator workflow, an explicit user instruction to migrate specified inputs to the configured target and an identified category is the write authorization for that scope. The operator may pass `--confirm-write` after checks without asking for a second confirmation. Existing configured fallbacks are part of this server migration policy, including the required template-authorization and typed direct-person/post switches, unless the user restricts them. Translation/check/dry-run-only requests do not authorize writes. Preserve the user's request and scope in task evidence. This rule does not authorize publication, arbitrary existing-target updates, the separately scoped repair paths below, or replay of uncertain writes; all executor validation and write gates remain enforced. The server procedure is documented in `docs/operations/codex-cli-migration.md` and `skills/mk-migrate-server/SKILL.md`.

An explicitly confirmed published-form repair may update only the current official form version of a named `MK_TEST_` template through `sysXFormOfficial/save`. It requires a matching target/category and snapshot digest, explicit field/action lists, private backups, and readback verification. Only enabling source-backed readonly permissions and preserving empty-text reads in existing onLoad actions are allowed. Template identity, publication state, data models, layout, unrelated form content, and workflow definitions must remain unchanged. The normal draft-only executor gate must not be weakened, and uncertain writes must not be retried.

An explicitly confirmed locked-draft recovery may act only on a named, still-draft `MK_TEST_` template that was created by a retained `readback_failed` execution report and never reached the transfer-record callback. A record-only reconciliation performs two stable readbacks and complete persisted-invariant verification before one transfer-record request; it must never call a template or workflow write API. A scoped repair additionally requires approved full DSL/report digests, a stable current snapshot digest, an unused private artifacts directory, private before/after backups, and a deterministic per-origin/target single-attempt lock outside that caller-selected directory. The only permitted repair deltas are the exact template-authorization collection normalization evidenced by the prior report, or the three native calculation paths for the evidenced detail-row formula and aggregate rule. Template identity, category, lifecycle, table and field identity, layout, unrelated form configuration, scripts, workflow graph/content, and publication state must remain unchanged. Any template, workflow, or transfer-record write whose result is uncertain locks the operation permanently and must not be retried. This exception must not weaken the normal new-draft executor or the published-form repair gate.

An explicitly confirmed source-bound public-reader closeout is a separate narrow exception. A registered, successful, still-draft `MK_TEST_` template may have only its formal readers and bound workflow reader metadata cleared under a freshly reviewed everyone Source/DSL and verified native empty-public capability; effective readers remain native-derived and the existing migration record must not be repeated. A known acknowledged locked-draft authorization write may finish only its never-started record phase inside the original claim after two stable complete readbacks, preserving the original permanent lock and historical receipts. Both operations require fresh full artifact/engine/snapshot approval, private backups, a deterministic single-use closeout-phase lock, persisted intent and receipts, and complete protected-state/readback verification. They do not permit template reconstruction, workflow-content deltas, publication, retry of any uncertain phase, deletion or modification of an old lock, or recovery by changing the target, batch, item, key, digest, or artifact directory. Native audit normalization is limited to the evidenced root/XForm/matching-main-model timestamps, independently typed editor ID references, and native audit initialization/advancement on exact unchanged detail-model identities. Detail audit normalization may only add the unchanged current root actor, add an empty deletion marker, and initialize/advance a valid timestamp within the current root-to-XForm update interval; substantive model/schema data remains byte-for-byte protected. Draft authority updates must transport the exact unchanged workflow content because omission can clear a draft graph. A separately, explicitly confirmed exact-graph restoration may append one restoration phase in the same known-acknowledged closeout claim: only a missing graph may be restored byte-for-byte from that phase's verified before backup under approved graph/result/current-snapshot digests. It preserves corrected authorization and all other state, never repeats the reader or record phase, and retains its own deterministic permanent single-attempt lock and all historical evidence. An uncertain or mismatching write remains ineligible.

## Engineering Rules

- Keep CLI and modules small.
- Prefer API-first execution.
- Do not use browser automation for the v2 executor path.
- Do not reference, invoke, copy from, or use the `onewo-k2-newoa-migration` skill as guidance for this project.
- Do not port broad v1 modules wholesale.
- Add features only when a fixture and a route-validation test exist.
- Preserve DSL as the only public boundary between translation and execution.
- Batch execution and repair orchestration may wrap the existing XML/DSL path. Persist task identity, write intent and receipts; unknown writes must never be automatically replayed. Batch repair must retain immutable per-item evidence and all existing scoped target-repair gates.

## Current Non-Goals

- No frontend.
- No batch publication or unrestricted updates to existing templates.
- No source formats outside the current XML route-validation scope.
- Current source input is either `*_SysFormTemplate.xml` or a paired directory with `*_SysFormTemplate.xml` and `*_LbpmProcessDefinition.xml`, optionally plus `*_KmReviewTemplate.xml` for the authoritative template name and, only when its root `fdId` matches both paired template IDs, fail-closed recovery of exact workflow person source identity evidence from fixed root author/authorization containers.
- No PI/Agent execution.
- No production writes without explicit confirmation.
