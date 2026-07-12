# Use temporary type-specific unresolved-participant fallbacks on route-validation origins

The current NewOA SIT organization directory intentionally does not contain every source workflow participant. Requiring a complete source-to-target identity mapping blocks route validation even when the approval graph itself is the behavior under test.

**Status**: accepted as a temporary route-validation exception

## Decision

- The exception applies only when the normalized execution origin is exactly one of:
  - `https://p-sit.onewo.com`
  - `http://mkpaaspoc.shanghai-electric.com`
  - `http://oa-dev.shanghai-electric.com:8088`
  Configuring any other origin through `NEWOA_BASE_URL` or `--base-url` does not carry these temporary fdIds into that environment.
- Source participants that return `not_found`, or whose only missing lookup evidence is `sourceParentName`, are replaced with a type-specific current identity:

| Source org type | Fallback | fdId |
| --- | --- | --- |
| 8 person / 32 role / 256 identity / unknown | AI迁移默认人 | `1j5e6gebgwkw1tvw1jqie81aeqnhg302viw0` |
| 4 post / 128 public post | AI迁移默认岗位 | `1jt85eh5hw23welj9w3jq4nba1522lpc3tw0` |
| 16 group | AI迁移默认群组 | `1jt85gq4uw23well7w25q9bmdj729u82tmw0` |
| 1 org / 2 department | AI迁移默认部门 | `1jt85rk85w23welrpw2s3uh4pvsr8ru35dw0` |

- Each used fallback fdId is validated through current `getElementInfo` evidence and must resolve uniquely as the expected organization type.
- Ambiguous matches, malformed source identities, target-shaped identity failures, and organization API failures remain blocking.
- Resolution clones the trusted DSL and produces an execution-local DSL. Persistence expectations and payloads are derived from that same resolved clone; the trusted input artifact is not rewritten.
- Resolved `members` and `alternativeMembers` are deduplicated by current fdId within each node collection, while audit counts retain the number of source references examined.
- Execution reports a `workflow.participant_sit_fallback_applied` warning with reference and identity counts plus the type-specific target fdIds.
- Address-field condition organization names that cannot be uniquely resolved on an allowed origin likewise fall back to `AI迁移默认部门` (`1jt85rk85w23welrpw2s3uh4pvsr8ru35dw0`).

## Consequences

- Route validation on the allowed NewOA origins can create a structurally inspectable draft without pretending that temporary handler identities are production mappings.
- Native explicit-handler fields keep source org-type shape when a matching fallback exists, instead of collapsing every unresolved participant onto one person.
- This exception must be removed when the target directory or an explicit identity-mapping mechanism becomes authoritative.

## Verification

- Sanitized public Route cases prove participant and condition-organization fallbacks through the Executor seam without network access, including the Shanghai Electric development origin.
- Source 167 local-corpus coverage proves all 57 unique identities and 326 participant references are resolved by the temporary type-specific policy.
- Boundary tests keep non-SIT origins, ambiguity, malformed evidence, API failures, and fallback type mismatches blocking.
