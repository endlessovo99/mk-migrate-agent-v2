# Business-card form layout regression

This form-only fixture retains the root `fdDesignerHtml`, `fdDisplayJsp` and
`fdMetadataXml` from the source4 `16817e47cf4be94686b61d64b688b7ea` export.
Template identifiers are replaced and history/workflow records are omitted.
The preserved evidence includes separate positive-width name inputs, zero-width
address selectors, independent captions, the job-title input/slash/input group,
and the four-column source geometry.

The target inspected on 2026-09-10 was
`MK_TEST_印制名片申请_20260905082514` at `http://oadev.shanghai-electric.com`.
Its stored desktop layout omitted both `.name` inputs and retained selector
labels. The user screenshot also showed vertical stacking of same-cell controls.

Native contract checked through read-only asset requests:
`/web/sys-xform/desktop/api/XFormIDE/index.js`, desktop digest release
`4dc12919af1531c82de2356c4ded8777`. GridItem uses a vertical receiver in the editor
and an `ele-grid-item-inner` wrapper at runtime. The native `@elem/xform-row`
container accepts `controlProps.spans` in 24-column units and assigns each direct
child width `span / 24 * 100%`. A row inside the source GridItem preserves the
outer four-column geometry while actually arranging the controls horizontally.
The paired CSS confirms the GridItem receiver's column direction.

Default tests only generate payloads and verify fake readbacks; they never write
to NewOA or use browser automation. Pixel-level target acceptance remains a
separate step after an explicitly confirmed new-draft execution.
