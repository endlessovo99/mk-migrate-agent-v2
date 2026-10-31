# Source-proven detail-cell presentation

The supported source shape contains exactly two visible inline text, textarea,
radio or single-select editors in one designer detail cell. Both have the same
proven physical header, and every recognized runtime rendering places the same
field pair, in order, in the same detail cell without an intervening break.
Hidden data fields remain separate and do not count as visible editors. Mixed
text, unsupported controls, block layout, conditional or ambiguous runtime
ownership, missing source evidence and older artifacts remain blocked.

The target keeps both native detail columns, field identities, values,
permissions, validators and event writers. Fixed form and detail-table onLoad
actions install the same idempotent scoped stylesheet and presentation markers.
The detail-table hook also runs in the native preview, where the global form
onLoad is deliberately skipped. On desktop it visually joins the
adjacent cells and clips the second title while retaining its required marker
and accessible label. On mobile it removes the separator and clips the second
title only while both original row controls are visible and adjacent. It never
reparents, hides or writes a business control. Native row keys remain intact.

Desktop header identity is resolved against the native column metadata and all
possible ordered matches; ambiguous mappings are left unchanged, including in
an empty table. Mobile pairing requires unique controls in the same row, with
at most one known hidden native sentinel between them. A scoped observer updates
markers when the table, permissions or visibility changes and removes its own
state when the native form changes. Missing APIs, unexpected DOM, duplicate
roots or browsers without the required DOM observer APIs leave the original separate presentation
visible. This is a conservative fallback, not equivalent grouped presentation.

The generated action is part of persisted script readback. Execution requires
the recorded QAS origin, native desktop/mobile SDK releases, element registry,
and all listed JavaScript/CSS asset hashes before any template write. A changed
bundle or another origin remains blocked pending its own evidence. These gates
do not authorize updates to existing templates or publication.

Run the deterministic source, trust, execution and fake readback tests with:

```sh
node --test tests/route-validation/detail-cell-presentation.test.js tests/route-validation/detail-shared-source-cell.test.js tests/route-validation/detail-visibility-submission.test.js
```

The optional real-browser DOM regression is enabled with
`MK_DETAIL_CELL_BROWSER_TESTS=1`; `MK_LAYOUT_PLAYWRIGHT_MODULE` can name a
Playwright entry and `MK_LAYOUT_BROWSER_PATH` a Chromium executable. Set
`MK_DETAIL_CELL_BROWSERS=chromium,webkit` to run both engines when installed.
It uses synthetic DOM and no external network. QAS page experiments use only
temporary in-memory form state and intercepted non-read requests; they do not
prove saved instances, real mobile hardware or an approval flow.
