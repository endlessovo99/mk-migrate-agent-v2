# Native required runtime contract

The three CommonJS factories are exact scoped module extractions from the recorded NewOA XFormRuntime bundle. `provenance.json` records the GET URL, release, whole-bundle digest, module IDs/ranges and fixture digests. They are retained evidence and do not fetch or write anything during tests.

`native-required-runtime.js` supplies only React hook evaluation, widget metadata and an in-memory form host. The required permission-to-validator conversion, field attribute switch and detail column attribute switch execute the captured native code. This verifies the effective column validation contract without claiming browser or business-instance acceptance.
