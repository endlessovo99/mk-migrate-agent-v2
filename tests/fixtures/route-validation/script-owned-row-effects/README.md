# Complete callback ownership

The first source callback performs row visibility/required operations and a
hard-hidden value assignment. The compiler must retain the complete ordered
callback without also generating a deferred native rule for those same row
effects. The separate native-only callback keeps its native rule and credit.

This protects against the captured native runtime pairing a current change with
an older full-values snapshot and overwriting the correct source callback's
visibility. It changes no native runtime asset. Tests use fake clients; actual
runtime acceptance is separate.
