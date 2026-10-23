# Explicit supported-only detail state

`native-detail-state-supported-only` is a caller-authorized behavior change for
a narrow legacy detail-row program. It is not full source equivalence and is
never enabled by ordinary drafting or model review.

The caller must explicitly choose supported behavior, bind the complete original
Source Draft, target origin/category and authorization evidence, and list the
exact ordered script hashes and pending action hashes. Use
`buildSupportedDetailStateDecision` to construct reviewable decision data; it
does not authorize the decision. Apply it through the existing migration-policy
envelope and normal batch repair, review, trust, approval and executor paths.

The profile retains the existing native radio `onChange` implementation of the
source hidden-value, visibility and required branch. It preserves the complete
form, workflow and existing native linkage rules. It records these six accepted
differences explicitly:

- Dynamic per-row placeholder changes are excluded; the static hint remains.
- Source ancestor/sibling-wrapper hiding is excluded.
- Source every-click dispatch is excluded; NewOA's native radio behavior applies,
  including its behavior when clicking an already selected option.
- Source add/delete/move handler rebinding and timing are excluded; native detail
  operations remain.
- Source on-load reconstruction and checked-attribute fallback are excluded.
  Initial visibility/required state remains native until a retained event changes it.
- Additional source helper validation restoration on main/budget/load events is
  excluded; static validation and existing native rules remain.

Only the complete closed source syntax/effect domain is eligible. Automatic row
data mutations, value writes outside the proven hidden-state helper, row-value
reset, submit hooks/vetoes, unknown calls, arbitrary handler strings, ambiguous
native fields, or differing/rebound helper cores are rejected. Script text is
inventoried without evaluating it. The new source interpreter and component
bridge are not used as runtime capabilities by this profile.

Inline handlers require the same lexical numeric loop index in the radio lookup
and the exact handler argument. Option interpolation must come from that same
radio with safe static values. Interpolation spans must occupy the actual parsed
arguments; fixed-row strings, foreign values, counter reassignment and placeholder
collisions hidden in comments are rejected.

Each altered action retains the original coverage/residual audit and exact action
digest. The approved fixed implementation is sealed against reviewer changes,
and workflow changes are rejected independently. Default unsupported-detail
residual checks remain unchanged. Existing targets and uncertain writes cannot
be retried through this policy.

Completion still requires a new draft, persisted readback and migration record.
Reports must list the accepted differences rather than call the result an exact
legacy migration.

## Optional approval-view main visibility

An explicit `buildSupportedDetailStateDecision(source, draft,
{viewInitialization: true})` decision additionally binds the existing onLoad
action to a versioned source-plan digest. Decisions without that option retain
their existing omission-only output.

The optional slice reads existing main radio values in `view` mode and changes
only the visibility of source-backed row regions. It proves static source
checked-value loops, conditional row effects and complete native target bindings.
It does not restore detail-row lifecycle, checked-attribute fallback, validation,
required state, data writes or row mutations. Add/edit rules stay unchanged.
The full source/action policy approval, deterministic trust regeneration and
persisted-script verification still apply. This does not authorize updating an
existing published form or expand its separate repair whitelist.
