# Use temporary type-specific unresolved-participant fallbacks on scoped SIT origins

The current NewOA SIT organization directory intentionally does not contain every source workflow participant. Requiring a complete source-to-target identity mapping blocks route validation even when the approval graph itself is the behavior under test.

**Status**: accepted as a temporary route-validation exception

## Decision

- The exception applies only when the normalized execution origin is exactly one of:
  - `https://p-sit.onewo.com`
  - `http://mkpaaspoc.shanghai-electric.com`
  - `http://oa-dev.shanghai-electric.com:8088`
  - `http://oadev.shanghai-electric.com`
  - `http://oaqas.shanghai-electric.com`
  - `https://oaqas.shanghai-electric.com`
  Configuring any other origin through `NEWOA_BASE_URL` or `--base-url` does not carry these temporary fdIds into that environment.
  HTTP and HTTPS are separate origins; this list does not authorize other subdomains or non-default ports. HTTPS port `443` normalizes to the same origin, while `https://oaqas.shanghai-electric.com:8443` remains excluded.
- Source participants that return `not_found`, or whose only missing lookup evidence is `sourceParentName`, are replaced with a type-specific current identity:

| Source org type | Fallback | Default fdId | Optional environment override |
| --- | --- | --- | --- |
| 8 person / 256 identity / unknown | AI迁移默认人 | `1j5e6gebgwkw1tvw1jqie81aeqnhg302viw0` | `NEWOA_FALLBACK_PERSON_FD_ID` |
| 4 post / 128 public post | AI迁移默认岗位 | `1jt85eh5hw23welj9w3jq4nba1522lpc3tw0` | `NEWOA_FALLBACK_POST_FD_ID` |
| 16 group | AI迁移默认群组 | `1jt85gq4uw23well7w25q9bmdj729u82tmw0` | `NEWOA_FALLBACK_GROUP_FD_ID` |
| 1 org / 2 department | AI迁移默认部门 | `1jt85rk85w23welrpw2s3uh4pvsr8ru35dw0` | `NEWOA_FALLBACK_ORGANIZATION_FD_ID` |
| 32 role line | configured role line | none | `NEWOA_ROLELINEBACK_FD_ID` |

- Source org type `32` role lines stay blocking unless `NEWOA_ROLELINEBACK_FD_ID` is set. There is no built-in role default. A configured value is validated through `getElementInfo` and must be organization type `32`. Bracketed generic roles such as `<直线领导>` follow the same rule. Missing, duplicate, or failed role lookups remain blocking when the variable is absent.
- Template authorization identities remain blocking by default. An explicitly confirmed execution may pass `--allow-template-authorization-fallback` to apply the same type-specific fallbacks to unresolved readers, editors, all-readers, all-editors, and temporary/default readers or editors. Ambiguous or malformed template identities remain blocking. Source org type `32` template roles use `NEWOA_ROLELINEBACK_FD_ID` only when that variable is set.
- A repeatable `--template-authorization-override '<sourceId>=<targetFdId>'` is separate from workflow participant overrides. It may resolve only a template authorization source identity, requires one exact current target with the same name and organization type, and may tolerate only a missing source parent name. Workflow `--participant-override` mappings never apply to template authorization.
- Each override is optional and independent; missing or blank values keep the default. Each used fallback fdId is validated through current `getElementInfo` evidence and must resolve uniquely as its fixed expected organization type.
- Explicit `sourceId=targetFdId` mappings take precedence over fallback. Ambiguous matches, malformed source identities, target-shaped identity failures, and organization API failures remain blocking.
- Resolution clones the trusted DSL and produces an execution-local DSL. Persistence expectations and payloads are derived from that same resolved clone; the trusted input artifact is not rewritten.
- Resolved `members` and `alternativeMembers` are deduplicated by current fdId within each node collection, while audit counts retain the number of source references examined.
- Execution reports a `workflow.participant_sit_fallback_applied` warning with reference and identity counts plus the type-specific target fdIds.
- Address-field condition organization names that cannot be uniquely resolved on an allowed origin use the same organization fallback and `NEWOA_FALLBACK_ORGANIZATION_FD_ID` override as organization/department participants.

## Consequences

- In the [encrypted server operator workflow](../operations/codex-cli-migration.md), an explicit migration request plus configured fallbacks authorizes their use within that task, including the necessary template-authorization and typed direct-person/post flags. The Agent selects those flags proactively without requesting per-identity confirmation; user restrictions and all executor eligibility/type checks still apply.
- To select HTTPS oaqas, set `NEWOA_BASE_URL=https://oaqas.shanghai-electric.com` or pass that origin through `--base-url`. Batch execution uses the retained manifest `baseUrl`; changing the environment does not retarget an existing batch or its approval. The native form-rule runtime catalog separately registers this HTTPS origin and still verifies its release identities and bundle hashes. Fallback fdId configuration, type validation, explicit fallback switches, and NewOA write confirmation remain required under their existing rules. The fixed transfer-record callback endpoint is independent of the selected template origin.
- Route validation preserves a structurally inspectable draft without pretending that temporary handler identities are production mappings.
- Native explicit-handler fields keep source org-type shape when a matching fallback exists, instead of collapsing every unresolved participant onto one person.
- This exception must be removed when the target directory or an explicit identity-mapping mechanism becomes authoritative.

## Verification

- Sanitized public Route cases prove participant and condition-organization fallbacks through the Executor seam without network access, including the Shanghai Electric development origin and the HTTPS oaqas native-rule/condition-organization route. Resolver tests cover HTTPS oaqas person fallback; origin tests reject unregistered hosts and non-default ports.
- Source 167 local-corpus coverage proves all 57 unique identities and 326 participant references are resolved by the temporary type-specific policy.
- Boundary tests keep non-SIT origins, ambiguity, malformed evidence, API failures, and fallback type mismatches blocking.
