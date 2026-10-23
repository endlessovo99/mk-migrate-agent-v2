# Native notification evidence

Exact factory excerpts from the QAS XFormRuntime bundle already captured during
the publication/submission investigation. Provenance records the bundle hash,
source offsets and factory hashes. These fixtures contain no transport credentials.

The real desktop API exposes the LUI Message object, while the mobile toast calls
`Toast.show(Object.assign({}, options))`. Test hosts record calls to those UI
sinks; these tests establish the invocation contract, not a live rendered UI.
