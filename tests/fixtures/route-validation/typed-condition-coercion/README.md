# Typed condition coercion

These sanitized form-only XML fixtures differ only in whether the source load
callback compares its hidden String read to numeric or string literals. The
binding domain remains unproven. Canonical values `11` and `22` therefore cannot
prove that numeric loose equality is equivalent to string equality: `011`,
`11.0`, and padded numeric Strings are counterexamples.

The Route case crosses the production Translator, model patch validator, and
independent trust validator offline. It verifies the deterministic candidate
retains source literal types, preserved numeric comparisons accept either stable
nullish String normalization, and narrowed or forged predicates are rejected.
No external services or writes are used.
