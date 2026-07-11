# MK Migration V2 Context

This context defines the language for the v2 NewOA/MK migration route-validation rebuild.

## Language

**Route-validation version**:
A deliberately narrow implementation used to prove the new source-to-NewOA path before rebuilding product features.
_Avoid_: full replacement, complete platform

**Route-validation harness**:
An offline verification path for a named supported migration route case, used to prove behavior without external writes.
_Avoid_: fixture catalog, production executor, batch runner

**Route case**:
A named migration scenario that starts from a supported XML input and follows the route-validation path to its expected terminal stage.
_Avoid_: raw fixture, handcrafted DSL scenario, batch item

**DSL**:
The target-semantic migration document family used at the translation-to-execution boundary. A DSL Draft is non-executable; only Trusted DSL is consumed by the Executor, and no source artifact crosses that boundary.
_Avoid_: native payload, browser script, source draft

**Translator**:
The source-specific component that extracts a Source Draft from current route-validation source XML and deterministically maps it to a DSL Draft.
_Avoid_: executor, API writer

**Source Intake**:
The source-specific first stage of the Translator that reads supported XML and emits source-side fact fragments for Source Draft assembly. It owns source parsing, matching, reconciliation, Source Kind derivation, source diagnostics, and optional non-authoritative Mapping Hints, but no authoritative NewOA/MK target selection.
_Avoid_: XML-to-DSL adapter, target mapper, source file loader

**Source Draft**:
The source-side migration artifact assembled from Source Intake fragments after source parsing, matching, and normalization. It preserves raw source evidence, target-neutral Source Kinds, Source Semantic Facts, source issues, and optional non-authoritative Mapping Hints, but contains no authoritative NewOA/MK target selection or executable target semantics.
_Avoid_: legacy DSL, target model, executor input

**Source Kind**:
A target-neutral classification of a source control or workflow concept derived during Source Intake while retaining the raw designer and metadata evidence. In the current Source Draft schema it is a composite of `sourceType` and explicitly enumerated discriminator fields in `sourceProps`, not a new `sourceKind` field; other raw attributes remain evidence and do not implicitly participate in target selection.
_Avoid_: DSL field type, component ID, raw fd_type

**Source Semantic Fact**:
A normalized behavior or relationship derived solely from source evidence that remains meaningful without reference to NewOA/MK. It may use canonical terms such as visible, editable, required, condition, event, or graph edge, but retains the raw source mode, attributes, or evidence from which it was derived.
_Avoid_: target component choice, target API, executable target status

**Canonical Source Identity**:
A deterministic, collision-checked identity assigned during Source Intake only to a derived source entity that has no natural source ID. It is based on retained source markers or evidence, satisfies the shared Source Draft/DSL identity constraints, and is preserved unchanged by semantic mapping.
_Avoid_: rewritten natural ID, target database ID, mapper-generated ID

**Mapping Hint**:
A non-authoritative, auditable target candidate attached to source evidence, such as possible target APIs or code-shaped target examples from the source function catalog. Code-shaped examples remain inert text: a Mapping Hint may inform semantic mapping or AI Agent Review but cannot be treated as executable target code, directly write DSL target semantics, establish executability, pass trust, or be consumed by the Executor.
_Avoid_: mapping decision, trusted mapping, executable configuration

**Unrepairable Mapping Error**:
A deterministic mapping failure that no legal AI Agent Review replacement patch can resolve without changing Source Draft, creating or deleting a DSL entity, or expanding mapper or Target Catalog capability. It blocks before an AI provider call.
_Avoid_: review candidate, provider error, execution-time resolution error

**DSL Draft**:
The non-executable target-semantic candidate produced from a Source Draft. It is subject to review and trust promotion before it can cross into the Executor.
_Avoid_: trusted DSL, executable DSL, source draft

**Trusted DSL**:
The executable DSL artifact produced after a reviewed DSL Draft passes local DSL and trust validation. It is the only migration artifact consumed by the Executor.
_Avoid_: DSL draft, source draft, NewOA payload

**AI Agent Review**:
The post-mapping review and repair stage that may apply locally validated, evidence-backed restricted patches to a DSL Draft before trust promotion. It is not part of the deterministic Translator semantic-mapping seam.
_Avoid_: deterministic mapper, PI/Agent execution, unrestricted DSL author

**Translator semantic-mapping seam**:
The sole deterministic ownership point that maps a Source Draft into a DSL Draft. It may delegate to focused family mappers while keeping authoritative target selection and executable target semantics out of Source Intake.
_Avoid_: XML adapter mapping, executor projection, one giant mapper

**Target Catalog**:
A versioned declaration of supported NewOA/MK target components, properties, events, or APIs used to validate mapped DSL semantics. It does not choose a target from Source Kind or contain source-specific mapping policy.
_Avoid_: source mapping table, Source Intake rule, native payload schema

**Native Projection**:
The Executor-side conversion of Trusted DSL semantics into NewOA's native persisted template structure. It is downstream of the DSL boundary and distinct from Translator semantic mapping.
_Avoid_: source translation, Source Kind mapping, XML adaptation

**Unmapped Workflow Node**:
A source workflow node whose identity and graph relationships were parsed but whose Source Kind has no supported deterministic DSL node mapping. It may retain a `review/manualTask` diagnostic placeholder with `pending_review` in DSL Draft to preserve graph shape, but can never enter Trusted DSL or the Executor.
_Avoid_: missing node, unresolved participant, executable review node

**SysFormTemplate XML**:
The current v2 form source file shape. It is supported as a single form-only input or as part of a paired source directory.
_Avoid_: legacy XML source, old source format

**LbpmProcessDefinition XML**:
The current v2 workflow source file shape. It is supported only when paired with the matching SysFormTemplate XML in a source directory.
_Avoid_: standalone workflow source, legacy flow source

**Executor**:
The source-agnostic component that validates DSL, builds a dry-run plan, performs confirmed API-first NewOA SIT test-template writes, and verifies readback.
_Avoid_: source parser, translator

**Persisted invariant**:
A DSL-required semantic property that must survive in NewOA's native persisted template structure.
_Avoid_: raw payload field, migration audit marker, runtime behavior

**Readback verification**:
The comparison of persisted invariants expected from the complete trusted DSL with persisted invariants observed from NewOA's native template structure. It does not prove designer or runtime behavior.
_Avoid_: response echo check, runtime smoke test, browser verification

**NewOA SIT executor path**:
The only current write path. It creates a new `MK_TEST_` draft template through NewOA APIs, saves form/workflow structure, reads back, and reports the created `fdId`.
_Avoid_: production execution, update existing template, publish

**needs_manual**:
A non-blocking warning status for migration details requiring human review.
_Avoid_: fatal validation error
