# Required detail permissions route

A required main field and required/optional/readonly detail columns must keep their own default required flags in native add/edit permissions. Captured native useAuth replay proves the effective validators, rather than only checking a serialized required marker. Readback mutations must reject missing, wrongly typed, conflicting and incorrect required permissions.

The same source layout supplies separate main and detail row markers for the conditional expansion route. Explicit source `required=false` becomes a declared optional DSL flag, which row requirements preserve; an unspecified DSL flag retains its existing force-required semantics. Disabling a row clears its validators. Readonly editors stay readonly, and direct field-level force-required calls keep their explicit semantics. Detail requirements use native column APIs rather than a required flag on the table container. Generated native form rules follow the same target semantics.
