# MK Migration V2 Context

This context defines the language for the v2 NewOA/MK migration route-validation rebuild.

## Language

**Route-validation version**:
A deliberately narrow implementation used to prove the new source-to-NewOA path before rebuilding product features.
_Avoid_: full replacement, complete platform

**DSL**:
The migration document produced by the translator and consumed by the executor. It is the only public boundary artifact.
_Avoid_: executor input, browser script

**Translator**:
The source-specific component that turns current route-validation source XML into DSL.
_Avoid_: executor, API writer

**SysFormTemplate XML**:
The current v2 form source file shape. It is supported as a single form-only input or as part of a paired source directory.
_Avoid_: legacy XML source, old source format

**LbpmProcessDefinition XML**:
The current v2 workflow source file shape. It is supported only when paired with the matching SysFormTemplate XML in a source directory.
_Avoid_: standalone workflow source, legacy flow source

**Executor**:
The source-agnostic component that validates DSL, builds a dry-run plan, performs confirmed API-first NewOA SIT test-template writes, and verifies readback.
_Avoid_: source parser, translator

**NewOA SIT executor path**:
The only current write path. It creates a new `MK_TEST_` draft template through NewOA APIs, saves form/workflow structure, reads back, and reports the created `fdId`.
_Avoid_: production execution, update existing template, publish

**needs_manual**:
A non-blocking warning status for migration details requiring human review.
_Avoid_: fatal validation error
