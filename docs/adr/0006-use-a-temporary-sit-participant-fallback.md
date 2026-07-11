# Use a temporary unresolved-participant fallback in NewOA SIT

The current NewOA SIT organization directory intentionally does not contain every source workflow participant. Requiring a complete source-to-target identity mapping blocks route validation for source 167 even when the approval graph itself is the behavior under test.

**Status**: accepted as a temporary SIT-only exception

## Decision

- The exception applies only when the exact execution origin is `https://p-sit.onewo.com`.
- Source participants that return `not_found`, or whose only missing lookup evidence is `sourceParentName`, are replaced with current person `1j8mu7vviw1owgp04w2v4p47v1rmcohi3tw0`.
- The fallback fdId is validated once through current `getElementInfo` evidence and must resolve uniquely as organization type `8`.
- Ambiguous matches, malformed source identities, target-shaped identity failures, and organization API failures remain blocking.
- Resolution clones the trusted DSL and produces an execution-local DSL. Persistence expectations and payloads are derived from that same resolved clone; the trusted input artifact is not rewritten.
- Resolved `members` and `alternativeMembers` are deduplicated by current fdId within each node collection, while audit counts retain the number of source references examined.
- Execution reports a `workflow.participant_sit_fallback_applied` warning with reference and identity counts plus the target fdId.

## Consequences

- NewOA SIT route validation can create a structurally inspectable draft without pretending that temporary handler identities are production mappings.
- Native explicit-handler fields use the resolved current identity; source identities remain available only as migration audit evidence.
- This exception must be removed when the target directory or an explicit identity-mapping mechanism becomes authoritative.

## Verification

- A sanitized public Route case proves the fallback through the Executor seam without network access.
- Source 167 local-corpus coverage proves all 57 unique identities and 326 participant references are resolved by the temporary policy.
- Boundary tests keep non-SIT origins, ambiguity, malformed evidence, API failures, and a non-person fallback target blocking.
