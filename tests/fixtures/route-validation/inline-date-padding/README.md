# Inline date padding fixtures

`base` and `renamed` are generic XML fixtures containing two explicit caption/date lines in one physical cell. The member order, BR boundary, date format, explicit px editor widths and identities are part of the expected contract.

`baseline-f23.json` records canonical SHA-256 fingerprints from unchanged F23 commit `ee8c9fffc6aaf4ab9d85539f97ff0e557f3220d6`: non-view native partitions, complete view tree/styles/theme, and desktop/mobile geometry. Tests call only the installed product implementation; they compare protected output against frozen data, not a second import alias. Do not regenerate this baseline from the changed implementation to silence a failure.

`readability-budget.json` is a generic fixed-width arithmetic example: 54 px input width, 73.164 px text width, and 32 px reclaimed from two 16 px right insets. It is not candidate browser rendering or a narrower-viewport guarantee. `provenance.json` binds the generic inputs, baseline and relevant F23 engine files; no real target or source identity is included.

Native fieldset style-consumption and native save/reassembly tests use the existing captured fixtures with explicit fake hosts. The actual left inset stays 16 px; no test claims that paddingControl.left removes it.
