# NewOA native calculation response-order hotfix

This is an independent, offline vendor-component patch. The migration CLI and
executor do not import or inject it, and it makes no network or NewOA writes.
The vendor source repository is not present in this workspace; the patch targets
exactly the captured `@elem/xform-calculate` asset reproduced by the tests.

## Behavior

An async formula response can commit only when all of the following still match:

- The component is mounted and still owns the same field, document, form and row.
- Its request generation is current.
- Its input-variable snapshot still matches the form values, including the window
  before another debounced request has started.
- A classic detail row still exists under the same native row key.

A discarded response updates neither component state nor the form value and runs
no onChange actions. A valid latest zero remains valid. The patch preserves the
native formatting, callbacks and current-response error behavior. It does not
change formulas, SUM rules, request DTOs, signatures or business scripts.

The patch uses the existing native `getFormulaVariableValue` and `getValueByName`
APIs. It adds one per-component ref and an effect cleanup, plus a check at the
existing async completion boundary. No global request counter is shared by rows.
Live form-instance replacement and in-place formula edits invalidate pending
responses even before another render. The native highCode scalar field getter
does not expose classic row collections, so it retains its own getter contract;
it still receives request-generation, input-snapshot and unmount protection.

## Version and output

Supported input SHA256:

```
284eba94bd9befb4652c78288d8f508e09c6bfffea7cc6b15c0de213985af523
```

The builder refuses any other input, including an already patched asset. It
validates both the expected AST structure and the output JavaScript syntax.

Run from this repository, with existing input and output-parent directories:

```sh
node --input-type=module - /path/to/original/index.js /path/to/patched/index.js <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { patchNativeCalculationResponseOrder } from './patches/newoa/calculation-response-order.js';
const patched = patchNativeCalculationResponseOrder(readFileSync(process.argv[2], 'utf8'));
writeFileSync(process.argv[3], patched, { flag: 'wx', mode: 0o600 });
console.log(createHash('sha256').update(patched).digest('hex'));
JS
```

This creates a new file and does not overwrite the original. The current patch
produces SHA256 `ba36aa738745ca3b9b7f0c7551ed39b89331beeb782be9b394f4d0652ecb215a`.

The platform owner must release this through NewOA's component/static-resource
pipeline, updating its resource manifest and cache revision as required. No
platform deployment has been performed by this change. Do not add this asset's
new digest to migration capability allowlists without revalidating those
contracts. A different vendor build needs its own reviewed patch and evidence.

## Regression boundary

```sh
node --test tests/route-validation/native-calculation-response-order.test.js
```

Tests execute the complete captured native component before and after patching.
React's host, form-value adapters and transport are simulated; they are not a
DOM/browser acceptance test. Response delivery is controlled without real timers
or target requests. Cases cover reversed responses, rapid edits, equal-value
revisions, pre-debounce input changes, independent rows, deletion, unmount,
identity reuse, effect cleanup/reactivation, main-table formulas, malformed
responses, native formatting and unchanged callback/action behavior.
