# Use minimal sanitized fixtures for default route validation

Default route-validation tests use minimal, sanitized, Git-tracked XML fixtures rather than complete source exports. This preserves the source structures needed to prove each Route case while keeping default tests reproducible, reviewable, and free of unnecessary sensitive data; complete local fixture corpora remain opt-in and never determine the result of `npm test`.

**Status**: accepted

## Consequences

- Every public Route case must use tracked XML fixtures and declare the behavior those fixtures prove.
- A behavior found in a complete local export must be reduced to a minimal sanitized fixture before it joins the default suite.
- Optional local corpora may support diagnosis, but missing local files must not skip, fail, or change default tests.
