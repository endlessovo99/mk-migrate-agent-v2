# Callback event assignment fixtures

These synthetic forms preserve two legacy structures: a bound callback value copied before row conditions, and literal branch writes followed by an event-value fallback in the final `else`.

The prefix form also has an exact pair of checkbox clear operations: the serialized `extendDataFormInfo.value(...)` input is emptied and the matching underscored inputs are unchecked. Its target is explicitly `xform-checkbox`; the reviewed native clear uses `[]`. The retained native linkage owns row visibility and required state, so residual JavaScript does not duplicate those effects.

The offline reviewer is limited to these fixture spellings. Route tests use the normal review, trust, dry-run, fake executor and readback path, then inspect ordered script writes. Negative cases cover extra writes, wrong targets and origins, changed branches, reordered writes, missing or repeated clears, unpaired selectors, unsupported control types and missing native-rule evidence. No live NewOA behavior is claimed.
