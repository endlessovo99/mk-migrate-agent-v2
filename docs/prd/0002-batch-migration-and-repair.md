# Batch migration and repair

Status: implemented CLI scope. NewOA writes still require explicit approval and the existing executor gates.

## Outcome

Operators can execute XML migration batches, keep repair records, and apply an evidenced repair to matching items in a batch. Every item retains its source snapshot, attempts, target identity and validation evidence. The translation/execution business boundary remains trusted DSL.

## Acceptance

- Source inputs and target/category/mapping scope are frozen in an import manifest. Reimporting the same source identity into the same target/category/migration intention is rejected across batches.
- Workers use shared PostgreSQL state, transactional claims, leases and a global per-origin execution limit. Pausing stops new claims; committed external effects are never rolled back or blindly replayed.
- Prepare runs the existing cleaner, translator, AI review and trust/dry-run checks. Signed review checkpoints are persisted. Approval binds exact source/DSL/configuration and executable code/catalog digests.
- Before every normal executor write, intent is durably recorded; the receipt is stored before proceeding. A lost response or receipt quarantines that item. An expired worker with acknowledged remote effects needs investigation; a worker with no writes can be reclaimed.
- Repairs record cause, reason, evidence, version, selectors and action. Previews show applicability, differences and skip reasons per item. Approval binds the exact preview; stale/repeated/concurrent applications are rejected.
- Local batch repair supports re-preparation, source-identity-bound participant mappings, and individually supplied trusted DSL replacements. Existing-target repair only composes the locked-draft repair and transfer-record reconciliation contracts. There is no generic target patch or publication path.
- Application records retain before/after state, actor, results and validation, linked to both repair and item. Previous attempts remain immutable. Applying a local repair invalidates batch approval.
- Default tests use fake NewOA/model clients. PostgreSQL integration tests are explicitly opted into against an isolated schema. Throughput claims require representative live benchmarking; tests do not establish a production capacity.

## Non-goals

No frontend, publication, new source format, cross-platform project migration, unrestricted target repair, or automatic uncertain-write retry.
