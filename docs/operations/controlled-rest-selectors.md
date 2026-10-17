# Controlled REST selectors

`native-tic-rest-selector` is a registered migration policy for the narrow, fixture-backed GET selector profile. The normal boundary remains Source Draft → explicit policy → DSL → trust/execute checks → dry-run → new `MK_TEST_` draft → readback → transfer record. The existing batch manifest accepts each item's `migrationPolicies`; existing `migration_policies`/`reprepare` repair and approval rules still apply. This feature adds no scheduler or alternative executor.

## Required evidence and scope

A decision binds one original field `sourceRef`, exact `contractDigest` and `runtimeFactDigest`, root `scopeOrigin`, and `wireEvidenceSha256`. The policy envelope retains original source digest, exact target origin/category and caller authorization evidence. An evidence digest references retained verified facts; a syntactically valid digest or generated placeholder does not prove an unavailable source contract.

`request` contains `searchParameter` and an explicit array of `{sourceParameter,targetParameter}`. Every XML input must map once. The source search marker alone does not establish the actual TIC/upstream parameter name.

`response` requires `rowsPath`, `valueColumn`, `labelColumn`, typed `columns`, and `emptySelection: "clear-bound-values"`. Nothing defaults to `rows`, `id`, `name`, or a guessed search key. The evidence must cover the actual wire result and selection/empty-selection semantics. The XML callback must independently prove explicit empty-result clearing for its declared outputs.

`server` binds `fdId`, `code`, interface `semanticDigest`, `connectionId`, `connectionSemanticDigest`, a nonempty exact `callerIds` list, `readOnlyVerified: true`, and `readOnlyEvidenceSha256`. Raw URLs, SQL, credentials or source secrets do not belong in the public policy, DSL, browser request, or report.

Use `ticInterfaceSemanticDigest` and `ticConnectionSemanticDigest` from `src/executor/remote-selector-resources.js` on identity-verified private metadata to calculate resource seals. They preserve protocol/authentication/configuration and omit only documented display/audit fields. Do not use a hash of an unrelated entity or a manually chosen projection. Interface creation or runtime permission changes are outside this implementation test and retain their original authorization gates.

## Source and runtime subset

The XML intake independently derives hidden primary/readonly display roles, source hashes/ranges and a complete closed script witness. The AST grammar accepts generated GET selector/getter/callback units, same-row input addressing, ordered null-coercing output assignments and explicit empty-result clearing. Only the exact known row-address compatibility polyfill is classified as scaffolding; it is not emitted as a prototype mutation. Unknown statements, custom callbacks, unproved prerequisites, dynamic locators, cross-detail mappings or missing effects stay blocked.

The native modal queries only after explicit search. It snapshots inputs when opened, validates rows before writes, preserves ordered output overrides, and uses a stable row key at query, confirmation and explicit clear. Cancellation, query error, empty search results, stale results and deleted/ambiguous rows do not write values. Explicit clear is distinct from cancellation and an empty result set. Inputs/outputs in this profile bind primitive String fields.

Only the complete fixed generator plus its exact policy/source/field bindings receives the narrow native API allowance. Ordinary JavaScript checks remain restrictive. Complete mapping tuples are rebuilt from the source contract and actual main/detail fields, independently of the mutable audit. Resigning a modified function/audit cannot redirect a detail write to main scope or another field. Fixed function serialization is canonical so database JSON key order does not change its proof.

## Metadata checks and readback

Before any template write, `verifyRemoteSelectorResources` reads only native interface/connection metadata and caller identities. It never calls TIC execute/executeForAjax, an upstream API, or a resource write. The supported native subset requires:

- Active REST GET query interface with read usage, body response, no paging, stream, error handler, hidden body/header/cookie input schema or interface abilities.
- Ajax enabled with an exact nonempty native person ACL; each caller independently exists, is active and has person type `8`. Logs remain disabled.
- Exact resource/connection IDs, same system, approved origin and semantic seals.
- Native GET `fdInParam == fdQueryParam` with the exact public String parameters; body `fdBodyResponse` proving the declared array path and scalar columns, with matching `fdOutParam` when the load API returns that derived field. This is the conservative native formatter subset, not general JSON Schema support.

After the normal persisted form/rule/script/envelope/workflow verification, resources are read again and checked against the same approved seals and restrictions. Success records `readback.partitions.remoteResources: "verified"`. Any postwrite resource drift or unavailable read yields `readback_failed`, retains the created target and withholds the transfer record. Normal unknown-write handling remains unchanged; this feature performs no retry or repair of existing targets.

The source/getter/callback fixture, captured native button dispatcher fixture, fake native resources and public batch route cover this chain without a model, database server or network. Fake readback success establishes tool behavior only. It does not establish real source connectivity, a real wire contract, browser acceptance or business equivalence.

## Current external blockers

This implementation does not authorize or implement upstream POST execution. Actual PR task/work-order POST selectors remain blocked pending their real request/response and read-only contracts. PR/opportunity GETs can now produce source script witnesses, but no real decisions were created: their authoritative protocol, live response/value/display/search/empty-selection contract and eligible runtime resources still need verification. Existing discovery resources with Ajax disabled are intentionally not accepted as runtime-ready selectors.

Once real evidence is available, affected unexecuted items require the existing repair/reprepare, checks, new engine/DSL approval digest and serialized execution. Keep historical unknown locks, successful targets and deferred sources intact.
