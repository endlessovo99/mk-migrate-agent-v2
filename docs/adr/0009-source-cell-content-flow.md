# Preserve source cell content flow

Source Intake retains a cell's ordered controls, explicit `BR` / `brcontrol` boundaries, and explicit item widths as `contentFlow`. Transparent presentation wrappers preserve those boundaries; an atomic control, script, JSP fragment, or nested table owns its internal markup. Empty lines represent explicit consecutive or edge breaks. Widths use finite, non-negative `px` or `%` values, including deliberate zero-width source controls.

The Source Draft and DSL cell shape is:

```json
{
  "contentFlow": {
    "lines": [["fd_start", "fd_end"], [], ["fd_note"]],
    "items": [
      { "referenceId": "fd_start", "width": { "value": 160, "unit": "px" } },
      { "referenceId": "fd_end", "width": { "value": 40, "unit": "%" } },
      { "referenceId": "fd_note" }
    ]
  }
}
```

Each executable field-cell reference occurs exactly once, in order, in both `lines` and `items`. Multi-reference field cells retain `keepInline: true` for grid membership; `contentFlow` governs their internal arrangement. Detail tables retain their exclusive-cell projection. The mapper remaps content references together with field IDs. A merged address display companion contributes its position and width to the surviving address control.

Source unit labels remain source entities with their original identities. The mapper consumes a unit label only when the chosen target component supports a matching native unit. Otherwise it retains a description control. Calculated fields keep their distinct native calculation profile; ordinary number formatting is not a substitute for that profile. Hidden titles use the shared native fieldset contract across visible components.

The Executor projects flow through XForm's built-in `div` containers with explicit CSS flex styles. Generic `@elem/flex` and `@elem/flex.FlexItem` components are not registered as XForm containers: its renderer silently skips their subtrees. Explicit lines remain distinct, items retain their widths with a 100% maximum, and each line can wrap at the available width. This adds no internal table borders. The native registration and rendering methods are retained with bundle provenance in `tests/fixtures/executor/persistence/form-renderer-registration.json`; tests replay that traversal from source XML through persisted field references on desktop and mobile. Field label evidence remains in `hidden-label-runtime/provenance.json`.

Trust checks compare source line boundaries, item dimensions, hidden titles and unit text with the DSL. A source rebuild authorizes existing data-only and address-companion transformations, consumed native units, and source-proven one-to-one caption folding. Caption folding retains the original source grid, verifies the complete field semantics and combined occupied region, and requires the intrinsic title to remain visible. The remaining presentation expectations come directly from source facts. Readback derives flow and effective native titles from the actual hierarchy and rendering properties on both desktop and mobile, independently of migration audit markers.

New DSLs explicitly select `form.layout.sizing = "adaptive"`. Source dimensions remain unchanged in `sourceGrid` and `contentFlow`; the target projection uses automatic grid tracks and stretchable visible editors. Descriptions and units keep intrinsic sizing, and explicit zero widths remain zero. Line boundaries, topology, field identities and behavior do not change. A missing sizing flag retains the original native width policy; mapping with `layoutSizing: "source"` is the explicit compatibility path.

Adaptive title styling is fixed executor infrastructure: a built-in `div` scopes an empty-HTML, empty-JavaScript `@elem/xform-html` stylesheet carrier to the created main table. Native `appearance` and `main` do not forward a usable DOM scope. Both title layers override fixed native widths; only a horizontal field's direct title wrapper receives the relative 50% cap, allowing long titles to wrap without constraining nested vertical fields. Readback checks each platform's actual scope, carrier, CSS, reachability and automatic grid/item styles. Model review cannot supply arbitrary CSS through the sizing mode.

Offline route tests cover both sizing policies, mixed controls, empty breaks, physical and percentage source evidence, identity changes, units, merged address controls, and corrupted source-to-DSL or native presentation. Executing retained renderer code verifies registration and stylesheet mounting. The manual browser evidence described in `../operations/adaptive-layout.md` covers computed CSS in an isolated native-DOM fixture. It does not establish server normalization or full interactive application acceptance; those require separately authorized test-draft execution and runtime verification. Existing draft recovery and published repair scopes do not gain permission to change layouts.

Status: accepted
