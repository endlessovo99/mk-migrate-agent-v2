# Complete physical root axis fixtures

The four XML files are synthetic source fixtures. `base` and `renamed` cover a complete four-column root, mixed controls separated by BR, an empty tail, a rowspan group and folded captions. `wide-caption` retains the native caption-width refusal. `nested-same-axis` contains a real independent nested table beside rowspan cells.

`baseline-f22.json` was captured before the product change at commit `d3a441f212ef8b934e856e992306d9c8596e6efd`. It contains only projected geometry, mobile geometry and canonical SHA-256 fingerprints of protected native partitions/mobile render/theme/styles. It contains no old product implementation. The tests call the installed public projection and persistence factory; they never compare two aliases of that same implementation.

`provenance.json` binds every input XML, the baseline JSON and the relevant baseline engine files. Baseline hashes use JSON with recursively sorted object keys and retained array order. Do not regenerate the baseline from the changed implementation to resolve a failure; first review the explicit XML expectations and protected-state contract.

Native save and track replay use existing captured fixtures and fake hosts. These tests establish offline projection/serialization behavior, not browser rendering, server persistence or business acceptance.
