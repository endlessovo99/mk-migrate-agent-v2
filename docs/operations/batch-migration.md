# Batch migration and repair

The batch CLI adds durable orchestration around the existing XML → trusted DSL → NewOA path. It uses PostgreSQL through `MK_BATCH_DATABASE_URL`. The database user must be able to create the `mk_migration_documents` table and its indexes in its configured schema. Use a dedicated database/schema and restrict access: source snapshots, DSLs and repair evidence are retained there. Credentials are read from environment variables, not manifests or database records.

## Import and prepare

Create a manifest. Source paths are relative to this file. Each source is an existing paired XML directory or a single SysFormTemplate XML file. Imports validate source shape and pairing atomically; correct invalid inputs before importing.

```json
{
  "version": 1,
  "name": "Finance migration wave 1",
  "migrationKey": "finance-wave-1",
  "baseUrl": "https://p-sit.onewo.com",
  "targetCategoryId": "<category fdId>",
  "executionConcurrency": 1,
  "items": [
    { "sourcePath": "./sources/template-a" },
    { "sourcePath": "./sources/template-b", "templateName": "Business template name" }
  ]
}
```

`migrationKey` identifies an intentional migration wave. Reusing it with the same source template, origin and category rejects duplicate creation even in another batch. Changing it represents a separately intended migration; never use a new key to bypass an uncertain write. Source bytes are captured at import. Workers use those snapshots rather than mutable source directories.

Each item may contain `executionOptions` with explicit participant/template-authorization/direct-participant mappings, type-specific fallback IDs, and the existing fallback switches. The CLI validates this allowlist; category, origin, target template and credentials cannot be overridden there. Batch fallbacks belong in the manifest, so later environment changes cannot silently change an approved plan.

```bash
node src/cli/main.js batch create manifest.json
node src/cli/main.js batch prepare <batch-id> --concurrency 2
node src/cli/main.js batch status <batch-id> --out batch-status.json
```

Preparation uses the normal model environment (`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`) and requires `AGENT_REVIEW_CHECKPOINT_KEY` of at least 32 characters. Share that key securely among workers that resume the same checkpoints. Preparation performs no NewOA writes. It stores source draft, DSL draft, signed checkpoints and validation reports per item. Keep workers on an identical fixed code/catalog version; changed versions require re-preparation and new approval.

## Approve and execute

Inspect the status report's `proposal` and `approvalDigest`. Approval covers the prepared items listed there, with their exact DSL, target and mapping configuration. It does not authorize later additions or modified items.

```bash
node src/cli/main.js batch approve <batch-id> --expected-digest <approvalDigest> --confirm-write --actor <operator>
node src/cli/main.js batch run <batch-id> --confirm-write --concurrency 2
```

Execution requires `NEWOA_USERNAME` and `NEWOA_ENCRYPTED_PASSWORD`. It creates new `MK_TEST_` drafts only. The per-origin `executionConcurrency` limit is shared across workers and batches. Manifests for the same origin must agree on this value. `--concurrency` controls local worker count; it cannot bypass the shared limit. Start with one remote write worker and measure before increasing capacity. Requests have a 60-second deadline by default (`--request-timeout-ms`); write timeouts are quarantined and never retried automatically.

To change an origin's limit, pause all its batches and wait for in-flight execution to finish, then run `batch limit <batch-id> <1..16> --actor <operator>`. This records the change, updates every batch for that origin and invalidates their approvals. Inspect and approve prepared items again before execution.

```bash
node src/cli/main.js batch pause <batch-id>
node src/cli/main.js batch recover <batch-id>
node src/cli/main.js batch retry <batch-id> <item-id>
node src/cli/main.js batch run <batch-id> --confirm-write
node src/cli/main.js batch item <item-id> --out item-evidence.json
```

Pause stops new claims; in-flight work records its outcome. `recover` considers expired leases only. A write intent without receipt becomes `outcome_unknown`; acknowledged writes without a completed run become `needs_repair`. Neither returns to template creation. A prewrite interrupted task can resume from its checkpoint. `retry` is limited to blocked items with no remote effects and requires a paused batch. Exhausted or incompatible AI checkpoints need a recorded `reprepare` repair. Successful items remain complete when a batch runs again.

## Repair records and local batch repair

A repair describes one evidenced problem; each application records what happened to one item. Example definition:

```json
{
  "title": "Resolve an obsolete participant identity",
  "rootCause": "The source person no longer exists in the target directory",
  "reason": "Apply the reviewed source-to-target identity mapping",
  "evidence": ["ticket-123 / directory lookup evidence"],
  "version": "1",
  "selector": { "diagnosticCodes": ["execute.newoa_api_failed"] },
  "action": {
    "kind": "execution_options",
    "options": { "participantOverrides": [{ "sourceId": "<source-id>", "targetFdId": "<target-id>" }] }
  }
}
```

Diagnostic codes narrow candidates; they do not establish applicability. Mapping changes also require matching, unambiguous identities in each DSL; target type/existence is still checked by the executor. Other local actions are `reprepare` (regenerate from the frozen XML using a fixed repaired tool version) and `replace_dsl` (explicit per-item `itemId`, `expectedDslDigest`, `dsl`, validated against source evidence).

```bash
node src/cli/main.js batch repair-create repair.json
node src/cli/main.js batch pause <batch-id>
node src/cli/main.js batch repair-preview <repair-id> --batch <batch-id> --out repair-preview.json
node src/cli/main.js batch repair-apply <preview-id> --expected-digest <digest> --confirm-apply --actor <operator>
node src/cli/main.js batch repair-history --batch <batch-id> --out repair-history.json
```

Use `--items id-a,id-b` on preview to select a subset. The preview retains per-item differences, applicability, validation and skip reasons. Any applicable item's state or repair definition changing invalidates the preview. Local application is transactional, one-time, requires a paused batch and clears migration approval. Reprepare pending items as needed, then inspect and approve the new migration proposal.

## Already-created drafts

Separate repair definitions may use `action: {"kind":"locked_draft","repairKind":"template_authorization"}` or `repairKind: "calculation"`, or `action: {"kind":"reconcile_transfer_record"}`. These retain every existing scoped gate: eligible `readback_failed` report, matching source/DSL/report digests, stable target evidence, exact allowlisted changes, private backups and verified readback. Unknown writes, successful migrations and generic existing-target changes are ineligible.

Preview uses read-only NewOA calls with environment credentials. Calculation repair may need `--replacements replacements.json`, an array of `{itemId, expectedDslDigest, dsl}`; the old and replacement DSL are bound to the preview and checked by the calculation repair contract.

```bash
node src/cli/main.js batch repair-preview <repair-id> --batch <batch-id> --out target-repair-preview.json
node src/cli/main.js batch repair-apply <preview-id> --expected-digest <digest> --confirm-write --actor <operator> --artifacts-root <new-private-directory>
```

A database claim prevents repeat target repair across workers, previews or artifact directories, in addition to the existing local permanent lock. Each confirmed target operation records intent before calling the underlying repair. Interrupted or uncertain target applications remain quarantined and are not resumed by rerunning the command. Retain all evidence for investigation. An `applying` scoped repair blocks batch resume until its outcome is resolved through a separately reviewed recovery procedure.

## Reporting and verification

`batch list`, `batch status`, `batch item`, `batch repairs`, `batch repair-show`, and `batch repair-history` expose the batch, item, repair and application records. Keep technical completion (verified template plus successful transfer recording) separate from business acceptance. The current reports provide item/attempt timestamps, states and evidence; they do not claim a measured throughput or automatic business acceptance.

Default tests use fake clients. An isolated PostgreSQL test can be opted into with `MK_BATCH_TEST_DATABASE_URL`; it must point at a disposable test database with schema-creation permission. Do not point tests at migration/business databases. Live NewOA acceptance and sustained-load measurement require a separately approved target/category and sample set.
