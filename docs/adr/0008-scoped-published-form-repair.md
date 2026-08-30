# Repair selected semantics in a published test form

**Status**: accepted

An explicitly confirmed repair of an existing published `MK_TEST_` form must not run the draft-template reconstruction path. The native version editor provides `sysXFormOfficial/loadById` and `sysXFormOfficial/save`, with a save payload containing only the official version `fdId`, `fdConfig`, and unchanged `mechanisms`. The version binds back to the template through `fdXForm.fdId` and `fdEntityId`. The observed API contract and module identities are recorded in `tests/fixtures/executor/persistence/published-form-api-evidence.json`.

The published-form executor accepts Trusted DSL plus an explicit target, category, snapshot digest, readonly field IDs, and onLoad action IDs. It uses the existing native projection only to derive candidate script bodies. It changes selected add/edit `editable` flags to false and replaces selected dispatcher child bodies only when their AST differs solely by source-evidenced nullish-to-empty String normalization. It does not write regenerated data models, layout, other scripts, or workflow content.

The default executor still rejects published targets. The opt-in path requires write confirmation, private backups and a fresh execution directory, checks target/version bindings and the snapshot again before saving, and performs exactly one save. It records uncertain transport outcomes without retry or rollback. The snapshot check reduces concurrent-edit risk but is not an atomic server precondition.

Returned `mechanisms.sys-auth.mechAuthToken` capabilities vary between authenticated sessions. They are excluded from snapshot comparisons and disk artifacts, including nested XForm mechanisms. Save requests retain the latest returned capability. No other authorization metadata is excluded.

Readback verifies the complete official configuration and its identity, retains template/category/table and published state, and protects the workflow definition. The server regenerates `fdProfileId` when saving an official form. Only the matching `fdProfileId` inside native `sys-xform:XFormComponent:` descriptors in `fdFormFields` and `defaultFormMetaData` is normalized during readback; every other descriptor value and `fdContent` remain protected. The server may also hydrate view-model `fdAlter` and `fdAlterTime` audit fields. These readback allowances do not apply to the pre-write snapshot comparison.

The design configuration may remain as before or receive exactly the same permitted patch if the server synchronizes it; no other difference is accepted. A version-only edit must be carried into any later design republish to avoid restoring old settings. Fake-client Route tests cover scope rejection, changed snapshots, manually modified scripts, uncertain writes, and unrelated readback mutations.
