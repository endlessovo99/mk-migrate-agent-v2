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

`workflowCooperationDefault` is an optional explicit string `"1"`, `"2"`, or `"3"`. It authorizes using the current native cooperation default for source `processType: "0"`; it does not establish what the legacy numeric value meant. The executor reads `lbpmConfig/getConfigs` and requires its current `nodeHandlerTurningWay` to equal the approved value before any write. Native values 1/2/3 retain their target meaning, conflicting or unknown source values are rejected, and original source attributes remain intact. Per-node decisions are retained in the execution report. Normal execution rejects source 0 without this policy; historical target recovery does not silently apply it. The direct execute CLI exposes the same option as `--workflow-cooperation-default <1|2|3>`.

Source sign nodes require an explicit operation-set mapping in `workflowOperationSetOverrides`. Each entry contains `sourceNodeType: "signNode"`, the exact `sourceOperationRefId`, `targetNodeType: "sign"`, `targetFlowType: "0"`, the exact `targetOperationRefId`, `expectedDefault: true`, and `expectedSemanticDigest`. The supported target is the native default standard-sign operation set. Read the exact target entity through `lbpmOperMain/get`, verify its identity and type, and use `signOperationSetDigest` from `src/executor/workflow-sign-policy.js` to calculate the digest. Do not use a hash of raw JSON or a hand-built projection. The executor checks the live entity before writing and checks the operation set referenced by the actual workflow readback before transfer recording. An unavailable or changed entity blocks completion.

When a source sign node declares main-document editing permissions, `workflowSignDocumentPolicy: "form-only-audit"` requires explicit caller authorization that the process uses the form only. This preserves each source permission in the audit without mapping main-document editing. It does not establish business equivalence. Keep this authorization and any operation-set substitution in task evidence. Ambiguous source structure or handlers remain blocked; these options do not bypass source trust.

Both options belong in the item execution options and approval digest, not in public DSL. The direct execute CLI accepts `--workflow-sign-document-policy form-only-audit` and `--workflow-operation-set-overrides <json-file>`; the JSON file contains the mapping array. Changing options for an unexecuted item uses the existing repair preview/apply and new approval workflow. These options do not extend the published-form, locked-draft or record-only recovery permissions.

```bash
node src/cli/main.js batch create manifest.json
node src/cli/main.js batch prepare <batch-id> --concurrency 2
node src/cli/main.js batch status <batch-id> --out batch-status.json
```

Preparation uses the normal model environment (`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`) and requires `AGENT_REVIEW_CHECKPOINT_KEY` of at least 32 characters. Share that key securely among workers that resume the same checkpoints. Preparation performs no NewOA writes. It stores source draft, DSL draft, signed checkpoints and validation reports per item. Keep workers on an identical fixed code/catalog version; changed versions require re-preparation and new approval.

## Approve and execute

Inspect the status report's `proposal` and `approvalDigest`. Approval covers the prepared items listed there, with their exact DSL, target and mapping configuration. It does not authorize later additions or modified items.

For the [encrypted server Codex workflow](codex-cli-migration.md), the user's explicit batch migration request authorizes normal draft execution within that scope. After checking the actual proposal, the operator records approval with the current digest and `--confirm-write` without requesting a second human confirmation. Use a truthful actor such as `codex-server` and retain the user's original request as the authorization evidence. This does not authorize preparation-only tasks, scope expansion, separately gated target repair or uncertain-write replay. Configured fallbacks and their required switches must be fixed in each item's `executionOptions` before approval.

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

An `execution_options` repair may also register `workflowCooperationDefault` for an unexecuted trusted item with evidenced source-0 review/send nodes. It retains the existing paused-batch, exact preview, no-remote-effects and new-approval requirements; live default validation remains deferred to the executor. Conflicting source attribute copies and unrelated nodes do not establish applicability.

Diagnostic codes narrow candidates; they do not establish applicability. Mapping changes also require matching, unambiguous identities in each DSL; target type/existence is still checked by the executor. Other local actions are `reprepare` (regenerate from the frozen XML using a fixed repaired tool version) and `replace_dsl` (explicit per-item `itemId`, `expectedDslDigest`, `dsl`, validated against source evidence).

For a `migration_policies` repair, selector code `BATCH_MIGRATION_POLICY_CHANGED` also matches when the proposed source-bound policy differs from the retained policy. This allows recording a newly authorized policy on an unprepared item without manufacturing a failed model or execution attempt. The preview retains the actual diagnostics and attempts. The existing paused-batch, exact source/origin/category, no-remote-effects and immutable preview gates still apply; application clears preparation and approval. An unchanged policy does not match this selector.

For `reprepare` only, selector code `BATCH_ENGINE_CHANGED` also matches an item's retained nonempty engine digest when it differs from the current engine. This permits rebuilding stale ready artifacts before approving or attempting execution. The preview retains the original diagnostics and engine digest; it does not insert an execution failure. Existing remote-effect, uncertain-write, active-item and completed-item exclusions still apply, and application clears approval before regeneration.

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
