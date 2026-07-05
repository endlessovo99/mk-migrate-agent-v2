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
The source-specific component that turns the single supported source shape into DSL.
_Avoid_: executor, API writer

**Executor**:
The source-agnostic component that validates DSL, builds a dry-run plan, performs confirmed API-first writes, and verifies readback.
_Avoid_: source parser, translator

**needs_manual**:
A non-blocking warning status for migration details requiring human review.
_Avoid_: fatal validation error
